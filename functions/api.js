export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    
    const action = url.searchParams.get('action');
    const mac = url.searchParams.get('mac');

    const adminActions = ['admin_list', 'admin_active_list', 'admin_credit_list', 'admin_clear_credit', 'admin_get_settings', 'admin_toggle_credit', 'admin_save_rates', 'get_rates'];
    if (!mac && !adminActions.includes(action)) {
        return Response.json({ error: 'Missing MAC Address' }, { status: 400 });
    }

    // UPDATED: Added 'v' (Validity in Hours) to each rate
    async function getRates() {
        let defaultRates = {
            std1: { n: "1 Hour", m: 60, p: 5, v: 24 },
            std2: { n: "3 Hours", m: 180, p: 10, v: 24 },
            std3: { n: "10 Hours", m: 600, p: 20, v: 48 },
            std4: { n: "24 Hours", m: 1440, p: 30, v: 72 },
            vip1: { n: "3 Days", m: 4320, p: 60, v: 72 },
            vip2: { n: "7 Days", m: 10080, p: 130, v: 168 },
            vip3: { n: "15 Days", m: 21600, p: 250, v: 360 },
            vip4: { n: "30 Days", m: 43200, p: 450, v: 720 }
        };
        try {
            const setting = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'rates_config'").first();
            if (setting && setting.value) {
                let parsed = JSON.parse(setting.value);
                if (Object.keys(parsed).length > 0) return parsed;
            }
        } catch(e) {}
        return defaultRates;
    }

    // HELPER: Wipes session if past expiration date
    async function checkExpiration(session) {
        if (!session) return null;
        if (session.expires_at && Date.now() > session.expires_at && session.total_minutes_bought > session.minutes_used) {
            await env.DB.prepare("UPDATE wifi_sessions SET total_minutes_bought = 0, minutes_used = 0, status = 'paused' WHERE client_mac = ?").bind(mac).run();
            session.total_minutes_bought = 0;
            session.minutes_used = 0;
            session.status = 'paused';
        }
        return session;
    }

    try {
        if (action === 'get_rates') {
            return Response.json(await getRates());
        }

        if (action === 'admin_save_rates') {
            const ratesJson = url.searchParams.get('rates');
            if (ratesJson === '{}') return Response.json({ error: 'Cannot save empty rates' }, { status: 400 });
            await env.DB.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('rates_config', ?)").bind(ratesJson).run();
            return Response.json({ success: true });
        }

        if (action === 'admin_get_settings') {
            let creditEnabled = 'false';
            try {
                const setting = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'credit_enabled'").first();
                if (setting) creditEnabled = setting.value;
            } catch(e) {} 
            return Response.json({ credit_enabled: creditEnabled });
        }

        if (action === 'admin_toggle_credit') {
            let current = 'false';
            try {
                const setting = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'credit_enabled'").first();
                if (setting) current = setting.value;
            } catch(e) {}
            const newVal = current === 'true' ? 'false' : 'true';
            await env.DB.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('credit_enabled', ?)").bind(newVal).run();
            return Response.json({ success: true, credit_enabled: newVal });
        }

        if (action === 'request_credit') {
            const name = url.searchParams.get('name'); const address = url.searchParams.get('address');
            const lat = url.searchParams.get('lat') || ''; const lng = url.searchParams.get('lng') || '';
            
            const existingSession = await env.DB.prepare("SELECT * FROM wifi_sessions WHERE client_mac = ?").bind(mac).first();
            const pCount = existingSession ? (existingSession.purchase_count || 0) : 0;
            if (pCount < 3) return Response.json({ error: 'ACCESS DENIED: You must purchase a plan at least 3 times to unlock emergency credit.' });

            const existingDebt = await env.DB.prepare("SELECT * FROM credits_log WHERE client_mac = ?").bind(mac).first();
            if (existingDebt) return Response.json({ error: 'ACCESS DENIED: Unpaid credit balance.' });

            const newExpiry = Date.now() + (24 * 3600000); // 24 Hours validity for emergency credit
            
            if (existingSession) {
                let baseTime = (existingSession.expires_at && existingSession.expires_at > Date.now()) ? existingSession.expires_at : Date.now();
                await env.DB.prepare("UPDATE wifi_sessions SET total_minutes_bought = total_minutes_bought + 180, status = 'paused', expires_at = ? WHERE client_mac = ?").bind(baseTime + (24 * 3600000), mac).run();
            } else {
                await env.DB.prepare("INSERT INTO wifi_sessions (client_mac, total_minutes_bought, minutes_used, status, purchase_count, expires_at) VALUES (?, 180, 0, 'paused', 3, ?)").bind(mac, newExpiry).run();
            }

            await env.DB.prepare("INSERT INTO credits_log (client_mac, customer_name, customer_address, amount_owed, lat, lng) VALUES (?, ?, ?, 10, ?, ?)").bind(mac, name, address, lat, lng).run();
            await env.DB.prepare("DELETE FROM digital_queue WHERE client_mac = ?").bind(mac).run();
            return Response.json({ success: true });
        }

        if (action === 'admin_credit_list') {
            const { results } = await env.DB.prepare("SELECT * FROM credits_log ORDER BY id DESC").all();
            return Response.json(results || []);
        }
        if (action === 'admin_clear_credit') {
            const id = url.searchParams.get('id');
            await env.DB.prepare("DELETE FROM credits_log WHERE id = ?").bind(id).run();
            return Response.json({ success: true });
        }
        if (action === 'admin_list') {
            const { results } = await env.DB.prepare("SELECT * FROM digital_queue WHERE status = 'waiting' AND requested_plan IS NOT NULL ORDER BY joined_at ASC").all();
            return Response.json(results || []);
        }
        if (action === 'admin_active_list') {
            const { results } = await env.DB.prepare("SELECT * FROM wifi_sessions WHERE status = 'playing' ORDER BY last_play_time DESC").all();
            return Response.json(results || []);
        }
        
        if (action === 'admin_approve') {
            const plan = url.searchParams.get('plan');
            const rates = await getRates();
            const minutesBought = rates[plan] ? rates[plan].m : 0;
            const validityHours = rates[plan] ? (rates[plan].v || 24) : 24;
            const addedTimeMs = validityHours * 3600000;

            const existingSession = await env.DB.prepare("SELECT * FROM wifi_sessions WHERE client_mac = ?").bind(mac).first();
            
            if (existingSession) {
                // Stack expiry time!
                let baseTime = (existingSession.expires_at && existingSession.expires_at > Date.now()) ? existingSession.expires_at : Date.now();
                let newExpiresAt = baseTime + addedTimeMs;
                await env.DB.prepare("UPDATE wifi_sessions SET total_minutes_bought = total_minutes_bought + ?, status = 'paused', purchase_count = COALESCE(purchase_count, 0) + 1, expires_at = ? WHERE client_mac = ?").bind(minutesBought, newExpiresAt, mac).run();
            } else {
                let newExpiresAt = Date.now() + addedTimeMs;
                await env.DB.prepare("INSERT INTO wifi_sessions (client_mac, total_minutes_bought, minutes_used, status, purchase_count, expires_at) VALUES (?, ?, 0, 'paused', 1, ?)").bind(mac, minutesBought, newExpiresAt).run();
            }

            await env.DB.prepare("DELETE FROM digital_queue WHERE client_mac = ?").bind(mac).run();
            return Response.json({ success: true });
        }

        if (action === 'admin_decline') {
            await env.DB.prepare("DELETE FROM digital_queue WHERE client_mac = ?").bind(mac).run();
            return Response.json({ success: true });
        }
        if (action === 'admin_suspend') {
            const session = await env.DB.prepare("SELECT * FROM wifi_sessions WHERE client_mac = ?").bind(mac).first();
            if (session && session.status === 'playing' && session.last_play_time) {
                const startTime = new Date(session.last_play_time + 'Z').getTime(); 
                const minutesPlayed = Math.floor((Date.now() - startTime) / 60000);
                const newTotalUsed = session.minutes_used + minutesPlayed;
                await env.DB.prepare("UPDATE wifi_sessions SET status = 'paused', minutes_used = ? WHERE client_mac = ?").bind(newTotalUsed, mac).run();
            }
            return Response.json({ success: true });
        }

        if (action === 'status') {
            let creditEnabled = 'false';
            try { const setting = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'credit_enabled'").first(); if (setting) creditEnabled = setting.value; } catch(e) {}

            const rates = await getRates();
            let sessionAll = await env.DB.prepare("SELECT * FROM wifi_sessions WHERE client_mac = ?").bind(mac).first();
            
            // Trigger Expiration Wiping!
            sessionAll = await checkExpiration(sessionAll);

            const pCount = sessionAll ? (sessionAll.purchase_count || 0) : 0;
            const isEligible = pCount >= 3;

            const queue = await env.DB.prepare("SELECT * FROM digital_queue WHERE client_mac = ?").bind(mac).first();
            if (queue) {
                let position = 1;
                if (queue.status === 'waiting') {
                    const ahead = await env.DB.prepare("SELECT COUNT(*) as count FROM digital_queue WHERE status = 'waiting' AND joined_at < ?").bind(queue.joined_at).first();
                    position = ahead.count + 1;
                }
                return Response.json({ type: 'queue', data: queue, position: position, credit_enabled: creditEnabled, eligible: isEligible, rates: rates });
            }

            if (sessionAll && sessionAll.total_minutes_bought > sessionAll.minutes_used) {
                return Response.json({ type: 'dashboard', data: sessionAll, credit_enabled: creditEnabled, eligible: isEligible, rates: rates });
            }

            return Response.json({ type: 'none', credit_enabled: creditEnabled, eligible: isEligible, rates: rates });
        }

        if (action === 'join') {
            await env.DB.prepare("INSERT OR IGNORE INTO digital_queue (client_mac, status) VALUES (?, 'waiting')").bind(mac).run();
            return Response.json({ success: true });
        }
        if (action === 'request') {
            const plan = url.searchParams.get('plan'); const rates = await getRates(); const amount = rates[plan] ? rates[plan].p : 0;
            await env.DB.prepare("UPDATE digital_queue SET requested_plan = ?, payment_amount = ? WHERE client_mac = ?").bind(plan, amount, mac).run();
            return Response.json({ success: true });
        }

        if (action === 'play') {
            let session = await env.DB.prepare("SELECT * FROM wifi_sessions WHERE client_mac = ?").bind(mac).first();
            session = await checkExpiration(session);
            if (session && session.total_minutes_bought > session.minutes_used) {
                await env.DB.prepare("UPDATE wifi_sessions SET status = 'playing', last_play_time = CURRENT_TIMESTAMP WHERE client_mac = ?").bind(mac).run();
                return Response.json({ success: true, status: 'playing' });
            }
            return Response.json({ error: 'Session expired or zero time' }, { status: 400 });
        }

        if (action === 'pause') {
            const session = await env.DB.prepare("SELECT * FROM wifi_sessions WHERE client_mac = ?").bind(mac).first();
            if (session && session.status === 'playing' && session.last_play_time) {
                const startTime = new Date(session.last_play_time + 'Z').getTime();
                const newTotalUsed = session.minutes_used + Math.floor((Date.now() - startTime) / 60000);
                await env.DB.prepare("UPDATE wifi_sessions SET status = 'paused', minutes_used = ? WHERE client_mac = ?").bind(newTotalUsed, mac).run();
            }
            return Response.json({ success: true, status: 'paused' });
        }

        return Response.json({ error: 'Invalid action' }, { status: 400 });

    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
}
