export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    
    const action = url.searchParams.get('action');
    const mac = url.searchParams.get('mac');

    // 1. Security Check: Allow the admin dashboard to fetch lists without a MAC address
    if (!mac && action !== 'admin_list' && action !== 'admin_active_list') {
        return Response.json({ error: 'Missing MAC Address' }, { status: 400 });
    }

    try {
        // ==========================================
        // ACTION: ADMIN LIST (View Pending Queue)
        // ==========================================
        if (action === 'admin_list') {
            const { results } = await env.DB.prepare(
                "SELECT * FROM digital_queue WHERE status = 'waiting' AND requested_plan IS NOT NULL ORDER BY joined_at ASC"
            ).all();
            return Response.json(results || []);
        }

        // ==========================================
        // ACTION: ADMIN ACTIVE LIST (View Connected Users)
        // ==========================================
        if (action === 'admin_active_list') {
            const { results } = await env.DB.prepare(
                "SELECT * FROM wifi_sessions WHERE status = 'playing' ORDER BY last_play_time DESC"
            ).all();
            return Response.json(results || []);
        }
        
        // ==========================================
        // ACTION: ADMIN APPROVE (Grant Time)
        // ==========================================
        if (action === 'admin_approve') {
            const plan = url.searchParams.get('plan');
            
            const planMinutes = { 
                '1H_5M': 60, '3H_5M': 180, '10H_5M': 600, '1D_5M': 1440, 
                '3D_10M': 4320, '7D_10M': 10080, '15D_10M': 21600, '30D_10M': 43200 
            };
            const minutesBought = planMinutes[plan] || 0;

            const existingSession = await env.DB.prepare("SELECT * FROM wifi_sessions WHERE client_mac = ?").bind(mac).first();
            
            if (existingSession) {
                await env.DB.prepare(
                    "UPDATE wifi_sessions SET total_minutes_bought = total_minutes_bought + ?, status = 'paused' WHERE client_mac = ?"
                ).bind(minutesBought, mac).run();
            } else {
                await env.DB.prepare(
                    "INSERT INTO wifi_sessions (client_mac, total_minutes_bought, minutes_used, status) VALUES (?, ?, 0, 'paused')"
                ).bind(mac, minutesBought).run();
            }

            await env.DB.prepare("DELETE FROM digital_queue WHERE client_mac = ?").bind(mac).run();
            return Response.json({ success: true });
        }

        // ==========================================
        // ACTION: ADMIN DECLINE (Reject/Remove User)
        // ==========================================
        if (action === 'admin_decline') {
            await env.DB.prepare("DELETE FROM digital_queue WHERE client_mac = ?").bind(mac).run();
            return Response.json({ success: true });
        }

        // ==========================================
        // ACTION: ADMIN SUSPEND (Force Pause User)
        // ==========================================
        if (action === 'admin_suspend') {
            const session = await env.DB.prepare("SELECT * FROM wifi_sessions WHERE client_mac = ?").bind(mac).first();
            
            if (session && session.status === 'playing' && session.last_play_time) {
                const startTime = new Date(session.last_play_time + 'Z').getTime(); 
                const minutesPlayed = Math.floor((Date.now() - startTime) / 60000);
                const newTotalUsed = session.minutes_used + minutesPlayed;

                await env.DB.prepare(
                    "UPDATE wifi_sessions SET status = 'paused', minutes_used = ? WHERE client_mac = ?"
                ).bind(newTotalUsed, mac).run();
                
                // TODO: Hit Omada API here to force Unauthorize the MAC
            }
            return Response.json({ success: true });
        }

        // ==========================================
        // ACTION: CHECK STATUS (Polled every 3 secs)
        // ==========================================
        if (action === 'status') {
            const session = await env.DB.prepare("SELECT * FROM wifi_sessions WHERE client_mac = ?").bind(mac).first();

            if (session && session.total_minutes_bought > session.minutes_used) {
                return Response.json({ type: 'dashboard', data: session });
            }

            const queue = await env.DB.prepare("SELECT * FROM digital_queue WHERE client_mac = ?").bind(mac).first();

            if (queue) {
                let position = 1;
                if (queue.status === 'waiting') {
                    const ahead = await env.DB.prepare(
                        "SELECT COUNT(*) as count FROM digital_queue WHERE status = 'waiting' AND joined_at < ?"
                    ).bind(queue.joined_at).first();
                    position = ahead.count + 1;
                }
                return Response.json({ type: 'queue', data: queue, position: position });
            }
            return Response.json({ type: 'none' });
        }

        // ==========================================
        // ACTION: JOIN QUEUE
        // ==========================================
        if (action === 'join') {
            await env.DB.prepare("INSERT OR IGNORE INTO digital_queue (client_mac, status) VALUES (?, 'waiting')").bind(mac).run();
            return Response.json({ success: true });
        }

        // ==========================================
        // ACTION: REQUEST PLAN
        // ==========================================
        if (action === 'request') {
            const plan = url.searchParams.get('plan');
            const prices = { 
                '1H_5M': 5, '3H_5M': 10, '10H_5M': 20, '1D_5M': 30, 
                '3D_10M': 60, '7D_10M': 130, '15D_10M': 250, '30D_10M': 450 
            };
            const amount = prices[plan] || 0;

            await env.DB.prepare("UPDATE digital_queue SET requested_plan = ?, payment_amount = ? WHERE client_mac = ?").bind(plan, amount, mac).run();
            return Response.json({ success: true });
        }

        // ==========================================
        // ACTION: PLAY (Unlock Internet)
        // ==========================================
        if (action === 'play') {
            await env.DB.prepare("UPDATE wifi_sessions SET status = 'playing', last_play_time = CURRENT_TIMESTAMP WHERE client_mac = ?").bind(mac).run();
            // TODO: Add fetch here to hit Omada API and Authorize MAC
            return Response.json({ success: true, status: 'playing' });
        }

        // ==========================================
        // ACTION: PAUSE (Lock Internet & Save Time)
        // ==========================================
        if (action === 'pause') {
            const session = await env.DB.prepare("SELECT * FROM wifi_sessions WHERE client_mac = ?").bind(mac).first();
            
            if (session && session.status === 'playing' && session.last_play_time) {
                const startTime = new Date(session.last_play_time + 'Z').getTime();
                const now = Date.now();
                const minutesPlayed = Math.floor((now - startTime) / 60000);
                const newTotalUsed = session.minutes_used + minutesPlayed;

                await env.DB.prepare("UPDATE wifi_sessions SET status = 'paused', minutes_used = ? WHERE client_mac = ?").bind(newTotalUsed, mac).run();
                // TODO: Add fetch here to hit Omada API and Unauthorize MAC
            }
            return Response.json({ success: true, status: 'paused' });
        }

        return Response.json({ error: 'Invalid action' }, { status: 400 });

    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
}
