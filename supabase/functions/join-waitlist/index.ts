import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { email, plan } = await req.json()

    if (!email || !email.includes('@')) {
      throw new Error('Invalid email address')
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SB_SERVICE_ROLE_KEY')!
    )

    // Save to waitlist table
    const { error } = await supabase
      .from('waitlist')
      .insert({ email, plan: plan || 'team' })

    if (error && !error.message.includes('duplicate')) {
      throw error
    }

    // Get current waitlist count
    const { count } = await supabase
      .from('waitlist')
      .select('*', { count: 'exact', head: true })

    // Send notification email via Resend
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'LawnBid <onboarding@resend.dev>',
        to: 'grove.winwin@gmail.com',
        subject: `New Team Waitlist Signup — ${count} total`,
        html: `
          <h2>New LawnBid Team Waitlist Signup</h2>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Plan:</strong> ${plan}</p>
          <p><strong>Total on waitlist:</strong> ${count}</p>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          <hr/>
          <p>View all waitlist signups in your <a href="https://supabase.com/dashboard/project/ceonccsuzgpdrzsythpe/editor">Supabase dashboard</a></p>
        `,
      }),
    }).catch(e => console.log('Email notification failed (non-critical):', e.message))

    return new Response(
      JSON.stringify({ success: true, count }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
