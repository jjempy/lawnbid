import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ADMIN_EMAILS = ['grove.winwin@gmail.com', 'jjempy@yahoo.com']

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Verify the requesting user is an admin
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('No authorization header')

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: userError } = await userClient.auth.getUser()
    if (userError || !user) throw new Error('Invalid user')
    if (!ADMIN_EMAILS.includes(user.email!)) throw new Error('Not authorized')

    // Parse request body
    const { userId, plan } = await req.json()
    console.log('[admin-update-plan] Admin:', user.email, '| Target:', userId, '| Plan:', plan)

    if (!userId || !plan) throw new Error('Missing userId or plan')
    if (!['free', 'pro', 'team'].includes(plan)) throw new Error('Invalid plan: ' + plan)

    // Use service role client to bypass RLS
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SB_SERVICE_ROLE_KEY')!
    )

    const { data, error } = await adminClient
      .from('settings')
      .update({ plan })
      .eq('user_id', userId)
      .select('user_id, plan')

    if (error) throw error
    if (!data || data.length === 0) throw new Error('No rows updated — user may not have a settings row')

    console.log('[admin-update-plan] SUCCESS:', data[0].user_id, '→', data[0].plan)

    return new Response(JSON.stringify({ success: true, data }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[admin-update-plan] ERROR:', err.message)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
