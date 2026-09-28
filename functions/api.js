export async function onRequest(context) {
    // context.env holds your database bindings
    // context.request holds the incoming URL and parameters
    const { request, env } = context;
    const url = new URL(request.url);
    
    const action = url.searchParams.get('action');
    const mac = url.searchParams.get('mac');

    // 1. Security Check: Require MAC address for all actions EXCEPT admin_list
    if (!mac && action !== 'admin_list') {
        return Response.json({ error: 'Missing MAC Address' }, { status: 400 });
    }

    try {
// ==========================================
        // ACTION: ADMIN LIST (View Queue)
        // ==========================================
        if (action === 'admin_list') {
            const { results } = await env.DB.prepare(
                "SELECT * FROM digital_queue WHERE status = 'waiting' AND requested_plan IS NOT NULL ORDER BY joined_at ASC"
            ).all();
            
            return Response.json(results || []);
        }
        
        // ==========================================
        // ACTION: ADMIN APPROVE (Grant Time)
        // ==========================================
        if (action === 'admin_approve') {
            const plan = url.searchParams.get('plan');
            
            // Convert plan codes to actual minutes
            const planMinutes = { 
                '1H_5M': 60, '3H_5M': 180, '10H_5M': 600, '1D_5M': 1440, 
                '3D_10M': 4320, '7D_10M': 10080, '15D_10M': 21600, '30D_10M': 43200 
            };
            const minutesBought = planMinutes[plan] || 0;

            // 1. Check if user already has an old session
            const existingSession = await env.DB.prepare("SELECT * FROM wifi_sessions WHERE client_mac = ?").bind(mac).first();
            
            if (existingSession) {
                // Add time to their existing session
                await env.DB.prepare(
                    "UPDATE wifi_sessions SET total_minutes_bought = total_minutes_bought + ?, status = 'paused' WHERE client_mac = ?"
                ).bind(minutesBought, mac).run();
            } else {
                // Create a brand new session
                await env.DB.prepare(
                    "INSERT INTO wifi_sessions (client_mac, total_minutes_bought, minutes_used, status) VALUES (?, ?, 0, 'paused')"
                ).bind(mac, minutesBought).run();
            }

            // 2. Remove them from the waiting queue
            await env.DB.prepare("DELETE FROM digital_queue WHERE client_mac = ?").bind(mac).run();
            
            return Response.json({ success: true });
        }

        // ==========================================
        // ACTION: CHECK STATUS (Polled every 3 secs)
        // ==========================================
        if (action === 'status') {
            // Check if they have an active paid session first
            const session = await env.DB.prepare(
                "SELECT * FROM wifi_sessions WHERE client_mac = ?"
            ).bind(mac).first();

            if (session && session.total_minutes_bought > session.minutes_used) {
                return Response.json({ type: 'dashboard', data: session });
            }

            // If no active session, check if they are in the queue
            const queue = await env.DB.prepare(
                "SELECT * FROM digital_queue WHERE client_mac = ?"
            ).bind(mac).first();

            if (queue) {
                let position = 1;
                // If they are waiting, calculate how many people are ahead of them
                if (queue.status === 'waiting') {
                    const ahead = await env.DB.prepare(
                        "SELECT COUNT(*) as count FROM digital_queue WHERE status = 'waiting' AND joined_at < ?"
                    ).bind(queue.joined_at).first();
                    position = ahead.count + 1;
                }
                return Response.json({ type: 'queue', data: queue, position: position });
            }

            // Not in queue, no active session
            return Response.json({ type: 'none' });
        }

        // ==========================================
        // ACTION: JOIN QUEUE
        // ==========================================
        if (action === 'join') {
            await env.DB.prepare(
                "INSERT OR IGNORE INTO digital_queue (client_mac, status) VALUES (?, 'waiting')"
            ).bind(mac).run();
            
            return Response.json({ success: true });
        }

        // ==========================================
        // ACTION: REQUEST PLAN (e.g., 3 Hours - ₱10)
        // ==========================================
        if (action === 'request') {
            const plan = url.searchParams.get('plan');
            
            // Hardcode prices on the backend for security
            const prices = { 
                '1H_5M': 5, '3H_5M': 10, '10H_5M': 20, '1D_5M': 30, 
                '3D_10M': 60, '7D_10M': 130, '15D_10M': 250, '30D_10M': 450 
            };
            const amount = prices[plan] || 0;

            await env.DB.prepare(
                "UPDATE digital_queue SET requested_plan = ?, payment_amount = ? WHERE client_mac = ?"
            ).bind(plan, amount, mac).run();
            
            return Response.json({ success: true });
        }

        // ==========================================
        // ACTION: PLAY (Unlock Internet)
        // ==========================================
        if (action === 'play') {
            // Update database to playing and log the exact UTC start time
            await env.DB.prepare(
                "UPDATE wifi_sessions SET status = 'playing', last_play_time = CURRENT_TIMESTAMP WHERE client_mac = ?"
            ).bind(mac).run();

            // TODO: Add cURL equivalent (fetch) here to hit Omada API and Authorize MAC
            
            return Response.json({ success: true, status: 'playing' });
        }

        // ==========================================
        // ACTION: PAUSE (Lock Internet & Save Time)
        // ==========================================
        if (action === 'pause') {
            const session = await env.DB.prepare("SELECT * FROM wifi_sessions WHERE client_mac = ?").bind(mac).first();
            
            if (session && session.status === 'playing' && session.last_play_time) {
                // Calculate minutes played using JavaScript
                const startTime = new Date(session.last_play_time + 'Z').getTime(); // Add Z for UTC
                const now = Date.now();
                const minutesPlayed = Math.floor((now - startTime) / 60000);
                
                const newTotalUsed = session.minutes_used + minutesPlayed;

                // Save frozen time to database
                await env.DB.prepare(
                    "UPDATE wifi_sessions SET status = 'paused', minutes_used = ? WHERE client_mac = ?"
                ).bind(newTotalUsed, mac).run();

                // TODO: Add cURL equivalent (fetch) here to hit Omada API and Unauthorize MAC
            }
            return Response.json({ success: true, status: 'paused' });
        }

        return Response.json({ error: 'Invalid action' }, { status: 400 });

    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
}
