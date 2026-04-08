import Stripe from 'https://esm.sh/stripe@13?target=deno'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
})

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { priceId, userId, userEmail } = await req.json()

    if (!priceId || !userEmail) {
      throw new Error('Missing required fields: priceId and userEmail')
    }

    // userId is optional — landing page checkouts won't have one
    const hasRealUser = userId && !userId.startsWith('landing')
    const metadata = hasRealUser ? { userId } : { source: 'landing-page' }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://winwinlawnbid.com/app/?upgrade=success',
      cancel_url: 'https://winwinlawnbid.com/app/?upgrade=cancelled',
      customer_email: userEmail,
      metadata,
      subscription_data: {
        metadata,
        trial_period_days: 14,
      },
    })

    console.log('Checkout session created:', session.id, 'for:', userEmail)

    return new Response(
      JSON.stringify({ url: session.url }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('Checkout error:', err)
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
