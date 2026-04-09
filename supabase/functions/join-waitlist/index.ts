import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { email, plan } = await req.json()
    console.log('Waitlist signup attempt:', email, plan)

    if (!email || !email.includes('@')) {
      throw new Error('Invalid email address')
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SB_SERVICE_ROLE_KEY')!
    )

    // Save to waitlist table
    const { error: insertError } = await supabase
      .from('waitlist')
      .insert({ email, plan: plan || 'team' })

    if (insertError) {
      console.error('Insert error:', insertError)
      // Don't throw — duplicate emails are ok
    } else {
      console.log('Email saved to waitlist successfully')
    }

    // Get current count
    const { count } = await supabase
      .from('waitlist')
      .select('*', { count: 'exact', head: true })

    console.log('Current waitlist count:', count)

    // Send Resend notification
    const resendKey = Deno.env.get('RESEND_API_KEY')
    console.log('Resend key present:', !!resendKey)

    if (resendKey) {
      const emailPayload = {
        from: 'LawnBid <onboarding@resend.dev>',
        to: ['jjempy@yahoo.com'],
        subject: `New Team Waitlist Signup — ${count} total`,
        html: `
          <h2>New LawnBid Team Waitlist Signup</h2>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Plan:</strong> ${plan || 'team'}</p>
          <p><strong>Total on waitlist:</strong> ${count}</p>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          <hr/>
          <p>View all entries in your <a href="https://supabase.com/dashboard/project/ceonccsuzgpdrzsythpe/editor">Supabase dashboard</a></p>
        `,
      }

      console.log('Sending email via Resend...')

      const resendResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(emailPayload),
      })

      const resendResult = await resendResponse.json()
      console.log('Resend response status:', resendResponse.status)
      console.log('Resend result:', JSON.stringify(resendResult))

      if (!resendResponse.ok) {
        console.error('Resend error:', resendResult)
      } else {
        console.log('Email sent successfully via Resend')
      }
    } else {
      console.error('RESEND_API_KEY not found in environment secrets')
    }

    return new Response(
      JSON.stringify({ success: true, count }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('Waitlist function error:', err.message)
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
