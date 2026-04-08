import Stripe from 'https://esm.sh/stripe@13?target=deno'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature')
  const body = await req.text()

  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 })
  }

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!
    )
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message)
    return new Response(`Webhook error: ${err.message}`, { status: 400 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SB_SERVICE_ROLE_KEY')!
  )

  console.log('Processing webhook event:', event.type)

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.CheckoutSession
    const userId = session.metadata?.userId

    console.log('Checkout completed for userId:', userId)

    if (userId && session.subscription) {
      try {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string)
        const priceId = sub.items.data[0].price.id

        const plan = priceId === Deno.env.get('STRIPE_PRO_PRICE_ID') ? 'pro'
          : priceId === Deno.env.get('STRIPE_TEAM_PRICE_ID') ? 'team'
          : 'pro'

        console.log('Setting plan to:', plan, 'for userId:', userId)

        const { error } = await supabase.from('settings').upsert({
          user_id: userId,
          plan,
          stripe_customer_id: session.customer as string,
          stripe_subscription_id: session.subscription as string,
        }, { onConflict: 'user_id' })

        if (error) {
          console.error('Supabase upsert error:', error)
        } else {
          console.log('Plan updated successfully to:', plan)
        }
      } catch (err) {
        console.error('Error processing checkout:', err.message)
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription
    const userId = sub.metadata?.userId

    if (userId) {
      await supabase.from('settings')
        .update({
          plan: 'free',
          plan_cancelled: true,
          plan_expires_at: new Date((sub as any).current_period_end * 1000).toISOString(),
        })
        .eq('user_id', userId)
    }
  }

  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object as Stripe.Subscription
    const userId = sub.metadata?.userId

    if (userId) {
      const priceId = sub.items.data[0].price.id
      const plan = priceId === Deno.env.get('STRIPE_PRO_PRICE_ID') ? 'pro'
        : priceId === Deno.env.get('STRIPE_TEAM_PRICE_ID') ? 'team'
        : 'free'

      await supabase.from('settings')
        .update({ plan })
        .eq('user_id', userId)
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
