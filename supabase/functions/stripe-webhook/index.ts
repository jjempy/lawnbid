import Stripe from 'https://esm.sh/stripe@13?target=deno'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
})

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature')!
  const body = await req.text()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!
    )
  } catch (err) {
    return new Response(`Webhook error: ${err.message}`, { status: 400 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SB_SERVICE_ROLE_KEY')!
  )

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.CheckoutSession
    const userId = session.metadata?.userId
    if (userId) {
      const sub = await stripe.subscriptions.retrieve(session.subscription as string)
      const priceId = sub.items.data[0].price.id
      const plan = priceId === Deno.env.get('STRIPE_PRO_PRICE_ID') ? 'pro'
        : priceId === Deno.env.get('STRIPE_TEAM_PRICE_ID') ? 'team'
        : 'free'
      await supabase.from('settings').update({
        plan,
        stripe_customer_id: session.customer as string,
        stripe_subscription_id: session.subscription as string,
      }).eq('user_id', userId)
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription
    const userId = sub.metadata?.userId
    if (userId) {
      await supabase.from('settings').update({ plan: 'free' }).eq('user_id', userId)
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
