// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA MIGRATIONS — run these in Supabase SQL Editor if any column is missing.
// These are idempotent (ADD COLUMN IF NOT EXISTS), safe to run repeatedly.
// ─────────────────────────────────────────────────────────────────────────────
// ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS expiry_date timestamptz;
// ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS attachments jsonb DEFAULT '[]';
// ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS declined_reason text;
// ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS map_polygons jsonb DEFAULT '[]';
// ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS is_recurring boolean DEFAULT false;
// ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS recurring_frequency text;
// ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS last_completed_at timestamptz;
// ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS next_due_at timestamptz;
// ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS visit_count integer DEFAULT 0;
// ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS est_minutes integer;
// ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS revision_number integer DEFAULT 0;
// ALTER TABLE quotes   ADD COLUMN IF NOT EXISTS addons jsonb DEFAULT '[]';
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS quote_language text DEFAULT 'en';
// ALTER TABLE market_data ADD COLUMN IF NOT EXISTS addon_count integer DEFAULT 0;
// ALTER TABLE market_data ADD COLUMN IF NOT EXISTS addon_total decimal DEFAULT 0;
// ALTER TABLE market_data ADD COLUMN IF NOT EXISTS addon_names text;
//
// CREATE TABLE IF NOT EXISTS addons (
//   id bigserial PRIMARY KEY,
//   user_id uuid NOT NULL,
//   name text NOT NULL,
//   default_price decimal NOT NULL,
//   created_at timestamptz DEFAULT NOW()
// );
// CREATE INDEX IF NOT EXISTS addons_user_id_idx ON addons(user_id);
//
// Backfill a specific quote into market_data (run in Supabase SQL Editor):
// INSERT INTO market_data (
//   zip_prefix, area_sqft, perimeter_ft, complexity, risk, crew_size,
//   est_minutes, final_price, price_per_sqft, discount_pct, is_recurring,
//   recurring_frequency, outcome, quote_month, season
// )
// SELECT
//   SUBSTRING((regexp_match(address, '\b(\d{5})\b'))[1] FROM 1 FOR 3),
//   ROUND(area_sqft)::int,
//   ROUND(linear_ft)::int,
//   complexity, risk, crew_size, est_minutes,
//   final_price,
//   ROUND((final_price / NULLIF(area_sqft,0))::numeric, 4),
//   COALESCE(discount_pct, 0), COALESCE(is_recurring, false),
//   recurring_frequency, status,
//   TO_CHAR(created_at, 'YYYY-MM'),
//   CASE
//     WHEN EXTRACT(MONTH FROM created_at) BETWEEN 3 AND 5 THEN 'spring'
//     WHEN EXTRACT(MONTH FROM created_at) BETWEEN 6 AND 8 THEN 'summer'
//     WHEN EXTRACT(MONTH FROM created_at) BETWEEN 9 AND 11 THEN 'fall'
//     ELSE 'winter'
//   END
// FROM quotes WHERE quote_id = 'PASTE-QUOTE-ID-HERE';
// ALTER TABLE addons ENABLE ROW LEVEL SECURITY;
//
// ADMIN VIEW & POLICY (run in Supabase SQL Editor):
// CREATE OR REPLACE VIEW user_plan_admin AS
// SELECT
//   u.email,
//   u.id as user_id,
//   s.plan,
//   s.stripe_customer_id,
//   s.plan_cancelled,
//   u.created_at as signed_up,
//   u.last_sign_in_at
// FROM auth.users u
// LEFT JOIN settings s ON s.user_id = u.id
// ORDER BY u.created_at DESC;
//
// GRANT SELECT ON user_plan_admin TO authenticated;
//
// CREATE POLICY "Admin can update any plan"
// ON settings FOR UPDATE
// TO authenticated
// USING (
//   auth.jwt() ->> 'email' IN ('grove.winwin@gmail.com', 'jjempy@yahoo.com')
// )
// WITH CHECK (
//   auth.jwt() ->> 'email' IN ('grove.winwin@gmail.com', 'jjempy@yahoo.com')
// );
// CREATE POLICY "Users can manage own addons" ON addons FOR ALL USING (auth.uid() = user_id);
// -- Backfill est_minutes for existing quotes using the formula:
// --   wall = (crew_size >= 2) ? GREATEST(area_sqft/20000, linear_ft/3000)
// --                           : (area_sqft/20000 + linear_ft/3000)
// --   est_minutes = ROUND(wall * complexity * 60)
// -- UPDATE quotes SET est_minutes = ROUND(
// --   (CASE WHEN crew_size >= 2 THEN GREATEST(area_sqft::decimal/20000, linear_ft::decimal/3000)
// --         ELSE area_sqft::decimal/20000 + linear_ft::decimal/3000 END)
// --   * COALESCE(complexity, 1.0) * 60
// -- ) WHERE est_minutes IS NULL AND area_sqft > 0 AND linear_ft > 0;
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS follow_up_days integer DEFAULT 3;
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS language text DEFAULT 'en';
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS follow_up_enabled boolean DEFAULT true;
//
// CRITICAL: Run these to fix settings keying by user_id instead of id:
// ALTER TABLE settings ADD CONSTRAINT settings_user_id_unique UNIQUE (user_id);
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS plan_expires_at timestamptz;
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS plan_cancelled boolean DEFAULT false;
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS stripe_customer_id text;
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS profit_margin decimal DEFAULT 0.30;
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS company_logo_base64 text;
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS plan text DEFAULT 'free';
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS quote_count_this_month integer DEFAULT 0;
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS quote_count_reset_at timestamptz DEFAULT NOW();
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS quote_validity_days integer DEFAULT 30;
//
// Storage bucket: create `quote-attachments` in Supabase Dashboard → Storage.
//
// Admin: to manually upgrade a user to Pro, run in Supabase SQL Editor:
//   UPDATE settings SET plan = 'pro' WHERE user_id = 'paste-user-id-here';
//   -- find user id via: SELECT id, email FROM auth.users;
//
// SUPABASE AUTH URL CONFIG (Dashboard → Authentication → URL Configuration):
//   Site URL:      https://winwinlawnbid.com/app/
//   Redirect URLs: https://winwinlawnbid.com/app/
// This ensures confirmation/reset emails redirect to the app, not the landing page.
//
// EMAIL OTP CONFIRMATION (Dashboard → Authentication → Email Templates → Confirm signup):
//   Change the email template to show {{ .Token }} as the verification code, NOT {{ .ConfirmationURL }}.
//   Supabase generates 6-8 digit codes; the app accepts any length in that range.
//   Subject:  Your LawnBid verification code
//   Body:     Your LawnBid verification code is: {{ .Token }}
//             This code expires in 10 minutes.
//   This switches confirmation from magic-link to OTP, fixing in-app browser handoff issues.
//
// ANONYMOUS MARKET DATA TABLE:
// CREATE TABLE IF NOT EXISTS market_data (
//   id bigserial PRIMARY KEY,
//   zip_prefix text,
//   state text DEFAULT 'SC',
//   area_sqft integer,
//   perimeter_ft integer,
//   complexity decimal,
//   risk decimal,
//   crew_size integer,
//   est_minutes integer,
//   final_price decimal,
//   price_per_sqft decimal,
//   discount_pct decimal,
//   is_recurring boolean DEFAULT false,
//   recurring_frequency text,
//   outcome text DEFAULT 'sent',
//   declined_reason text,
//   days_to_outcome integer,
//   quote_month text,
//   season text,
//   market_ref_id uuid DEFAULT gen_random_uuid(),
//   created_at timestamptz DEFAULT NOW()
// );
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'

// ─── Client ───────────────────────────────────────────────────────────────────────
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

export default supabase
export { supabase }

// ─── Auth helper ──────────────────────────────────────────────────────────────────
async function currentUserId() {
  const { data } = await supabase.auth.getUser()
  return data?.user?.id || null
}

// ─── Quotes ───────────────────────────────────────────────────────────────────────
export async function loadQuotes() {
  const { data, error } = await supabase
    .from('quotes')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

// Whitelist of valid quotes table columns — anything else is dropped before upsert
const QUOTE_COLUMNS = [
  'quote_id', 'user_id', 'client_id', 'client_name', 'client_phone',
  'client_email', 'address', 'area_sqft', 'linear_ft', 'crew_size',
  'complexity', 'risk', 'mow_rate_used', 'trim_rate_used',
  'equipment_cost_used', 'discount_pct', 'formula_price', 'final_price',
  'status', 'notes', 'sent_at', 'accepted_at', 'expiry_date',
  'attachments', 'parent_id', 'declined_reason', 'is_recurring',
  'recurring_frequency', 'last_completed_at', 'next_due_at',
  'visit_count', 'map_polygons', 'est_minutes', 'revision_number',
  'addons', 'created_at', 'updated_at'
]

export async function upsertQuote(quote) {
  // Strip internal-only fields before saving
  const { isNew, existingId, parentId, saveClient, sentAt, clientId, ...rest } = quote
  const merged = {
    ...rest,
    parent_id: parentId || null,
    user_id: await currentUserId(),
  }
  // Whitelist: only known columns are sent to Supabase
  const record = {}
  for (const k of QUOTE_COLUMNS) {
    if (merged[k] !== undefined && typeof merged[k] !== 'function') record[k] = merged[k]
  }
  const { error } = await supabase
    .from('quotes')
    .upsert(record, { onConflict: 'quote_id' })
  if (error) { console.error('[LawnBid] upsertQuote error:', error.message, error.details, error.code); throw error }
}

export async function deleteQuote(quoteId) {
  const { error } = await supabase
    .from('quotes')
    .delete()
    .eq('quote_id', quoteId)
  if (error) throw error
}

export async function updateQuoteStatus(quoteId, status, extraFields = {}) {
  const payload = { status, updated_at: new Date().toISOString(), user_id: await currentUserId(), ...extraFields }
  Object.keys(payload).forEach(k => { if (payload[k] === undefined) delete payload[k] })
  const { error } = await supabase
    .from('quotes')
    .update(payload)
    .eq('quote_id', quoteId)
  if (error) { console.error('[LawnBid] updateQuoteStatus error:', error.message, error.details, error.code); throw error }
}

// ─── Clients ──────────────────────────────────────────────────────────────────────
export async function loadClients() {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('name')
  if (error) throw error
  return data || []
}

export async function upsertClient(client) {
  const record = { ...client, user_id: await currentUserId() }
  Object.keys(record).forEach(k => { if (record[k] === undefined) delete record[k] })
  const { error } = await supabase
    .from('clients')
    .upsert(record, { onConflict: 'id' })
  if (error) { console.error('[LawnBid] upsertClient error:', error.message, error.details, error.code); throw error }
}

export async function updateQuotesForClient(clientId, fields) {
  const userId = await currentUserId()
  const { error } = await supabase
    .from('quotes')
    .update(fields)
    .eq('client_id', clientId)
    .eq('user_id', userId)
  if (error) console.warn('[LawnBid] updateQuotesForClient error:', error.message)
}

// ─── Settings ─────────────────────────────────────────────────────────────────────
// SQL required:
// ALTER TABLE settings ADD CONSTRAINT settings_user_id_unique UNIQUE (user_id);
// (The id=1 pattern is legacy — user_id is now the primary key for upserts)

export async function initializeUserSettings(userId) {
  // Check if a settings row exists for this user
  const { data } = await supabase
    .from('settings')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (data) return // row already exists
  // Create a default settings row
  const { error } = await supabase
    .from('settings')
    .insert({
      user_id: userId,
      plan: 'free',
      mow_rate: 110, trim_rate: 18, equipment_cost: 12.35, hourly_rate: 22.80,
      minimum_bid: 55, complexity_default: 1.0, risk_default: 1.0,
      quote_validity_days: 30, profit_margin: 0.30,
      follow_up_days: 3, follow_up_enabled: true, language: 'en',
    })
  if (error) console.error('[LawnBid] Failed to create settings row:', error)
  else console.log('[LawnBid] Settings row created for new user:', userId)
}

export async function loadSettings() {
  const userId = await currentUserId()
  const { data, error, status } = await supabase
    .from('settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error && error.code !== 'PGRST116' && status !== 406) throw error
  return data || null
}

// Known settings columns — only these are sent to Supabase.
const SETTINGS_COLUMNS = [
  'mow_rate','trim_rate','equipment_cost','hourly_rate','minimum_bid',
  'complexity_default','risk_default','profit_margin','quote_validity_days',
  'follow_up_days','follow_up_enabled','language','quote_language',
  'company_name','company_phone','company_email','company_logo_base64',
  'plan','plan_cancelled','plan_expires_at',
  'quote_count_this_month','quote_count_reset_at',
]
export async function saveSettings(settings) {
  const userId = await currentUserId()
  const record = { user_id: userId }
  for (const k of SETTINGS_COLUMNS) {
    if (settings[k] !== undefined && typeof settings[k] !== 'function') record[k] = settings[k]
  }
  const { error } = await supabase
    .from('settings')
    .upsert(record, { onConflict: 'user_id' })
  if (error) { console.error('[LawnBid] saveSettings error:', error.message, error.details, error.code); throw error }
}

// ─── Quote Attachments ────────────────────────────────────────────────────────────
const ATTACH_BUCKET = 'quote-attachments'

async function resizeImage(file, maxW = 1200, maxH = 1200, quality = 0.8) {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = e => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        let w = img.width, h = img.height
        if (w > maxW || h > maxH) {
          const r = Math.min(maxW / w, maxH / h)
          w = Math.round(w * r); h = Math.round(h * r)
        }
        canvas.width = w; canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        canvas.toBlob(
          blob => resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })),
          'image/jpeg', quality
        )
      }
      img.src = e.target.result
    }
    reader.readAsDataURL(file)
  })
}

export async function uploadQuoteFile(quoteId, file) {
  const userId = await currentUserId()
  if (!userId) throw new Error('Not authenticated')
  // Resize images client-side before upload
  const toUpload = file.type.startsWith('image/') ? await resizeImage(file) : file
  const cleanName = toUpload.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const path = `${userId}/${quoteId}/${Date.now()}-${cleanName}`
  const { error } = await supabase.storage
    .from(ATTACH_BUCKET)
    .upload(path, toUpload, { contentType: toUpload.type, cacheControl: '3600', upsert: false })
  if (error) {
    const msg = (error.message || '').toLowerCase()
    if (msg.includes('bucket not found') || msg.includes('the resource was not found')) {
      throw new Error('Photo storage is not configured. Please contact support.')
    }
    throw error
  }
  // Use signed URL instead of public URL (bucket is private)
  const { data: signedData } = await supabase.storage
    .from(ATTACH_BUCKET)
    .createSignedUrl(path, 3600)
  return { path, url: signedData?.signedUrl || '' }
}

export async function refreshAttachmentUrls(attachments) {
  if (!attachments?.length) return attachments
  return Promise.all(attachments.map(async att => {
    if (!att.path) return att
    try {
      const { data } = await supabase.storage.from(ATTACH_BUCKET).createSignedUrl(att.path, 3600)
      return { ...att, url: data?.signedUrl || att.url }
    } catch { return att }
  }))
}

export async function deleteQuoteFile(path) {
  if (!path) return
  const { error } = await supabase.storage.from(ATTACH_BUCKET).remove([path])
  if (error) console.warn('Could not delete attachment:', error.message)
}

// ─── Quote count (for free plan limit) ────────────────────────────────────────────
export async function countRecentQuotes(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString()
  const { count, error } = await supabase
    .from('quotes')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', since)
  if (error) { console.error('[LawnBid] countRecentQuotes failed:', error); return 0 }
  return count || 0
}

// ─── Quote ID ─────────────────────────────────────────────────────────────────────
export async function nextQuoteId() {
  const { data, error } = await supabase.rpc('next_quote_id')
  if (error) throw error
  return data
}

// ─── Anonymous market data collection ─────────────────────────────────────────
export async function recordMarketData(quote, outcome = 'sent') {
  console.log('[Market Data] recordMarketData called:', outcome, 'area:', quote?.area_sqft, 'price:', quote?.final_price)
  try {
    const address = quote.address || ''
    const zipMatch = address.match(/\b(\d{5})\b/)
    const zip = zipMatch ? zipMatch[1] : null
    const zipPrefix = zip ? zip.slice(0, 3) : null

    const now = new Date()
    const month = now.getMonth()
    const season = month >= 2 && month <= 4 ? 'spring'
      : month >= 5 && month <= 7 ? 'summer'
      : month >= 8 && month <= 10 ? 'fall'
      : 'winter'

    const areaSqft = Math.round(Number(quote.area_sqft)) || null
    const perimeterFt = Math.round(Number(quote.linear_ft)) || null
    const finalPrice = quote.final_price
      ? Math.round(Number(quote.final_price) * 100) / 100
      : null
    const pricePerSqft = areaSqft && finalPrice
      ? Math.round((finalPrice / areaSqft) * 10000) / 10000
      : null

    const payload = {
      zip_prefix: zipPrefix,
      area_sqft: areaSqft,
      perimeter_ft: perimeterFt,
      complexity: quote.complexity
        ? Math.round(Number(quote.complexity) * 100) / 100
        : 1.0,
      risk: quote.risk
        ? Math.round(Number(quote.risk) * 100) / 100
        : 1.0,
      crew_size: Number(quote.crew_size) || 1,
      est_minutes: quote.est_minutes
        ? Math.round(Number(quote.est_minutes))
        : areaSqft && perimeterFt
          ? Math.round(
              (Number(quote.crew_size) > 1
                ? Math.max(areaSqft / 20000, perimeterFt / 3000)
                : (areaSqft / 20000) + (perimeterFt / 3000)
              ) * 60
            )
          : null,
      final_price: finalPrice,
      price_per_sqft: pricePerSqft,
      discount_pct: quote.discount_pct
        ? Math.round(Number(quote.discount_pct) * 100) / 100
        : 0,
      is_recurring: quote.is_recurring || false,
      recurring_frequency: quote.recurring_frequency || null,
      outcome,
      declined_reason: quote.declined_reason || null,
      quote_month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      season,
      ...(() => {
        const addonsArr = Array.isArray(quote.addons)
          ? quote.addons
          : (quote.addons ? (() => { try { return JSON.parse(quote.addons) } catch { return [] } })() : [])
        return {
          addon_count: addonsArr.length,
          addon_total: Math.round(addonsArr.reduce((s, a) => s + Number(a.price || 0), 0) * 100) / 100,
          addon_names: addonsArr.length > 0
            ? addonsArr.map(a => (a.name || '').toLowerCase().trim()).filter(Boolean).join(', ')
            : null,
        }
      })(),
    }

    if (import.meta.env.DEV) console.log('[LawnBid Data] Recording market data:', payload)

    const { error } = await supabase.from('market_data').insert(payload)
    if (error) console.error('[LawnBid Data] Insert error:', error)
    else console.log('[LawnBid Data] Market data recorded successfully')

  } catch (e) {
    console.log('[LawnBid Data] Collection skipped:', e.message)
  }
}

// ─── Admin ────────────────────────────────────────────────────────────────────
export async function adminFetchAllUsers() {
  const { data, error } = await supabase
    .from('user_plan_admin')
    .select('*')
    .order('signed_up', { ascending: false })
  if (error) { console.error('[LawnBid] adminFetchAllUsers error:', error); throw error }
  return data || []
}

export async function adminUpdatePlan(userId, plan) {
  console.log('[adminUpdatePlan] START - userId:', userId, 'plan:', plan)
  if (!userId || !plan) {
    console.error('[adminUpdatePlan] MISSING userId or plan - aborting')
    throw new Error('Missing userId or plan')
  }
  const { data, error } = await supabase
    .from('settings')
    .update({ plan })
    .eq('user_id', userId)
    .select('user_id, plan')
  console.log('[adminUpdatePlan] RESULT - data:', data, 'error:', error)
  if (error) {
    console.error('[adminUpdatePlan] ERROR:', error)
    throw error
  }
  if (!data || data.length === 0) {
    console.error('[adminUpdatePlan] NO ROWS UPDATED - userId may not exist in settings')
    throw new Error('No rows updated - user may not have a settings row')
  }
  console.log('[adminUpdatePlan] SUCCESS - updated to:', data[0].plan)
  return data
}

// ─── Add-on services library ──────────────────────────────────────────────────
export async function fetchAddons(userId) {
  const uid = userId || await currentUserId()
  if (!uid) return []
  const { data, error } = await supabase
    .from('addons')
    .select('*')
    .eq('user_id', uid)
    .order('created_at', { ascending: true })
  if (error) { console.error('[LawnBid] fetchAddons error:', error); return [] }
  return data || []
}

export async function createAddon(userId, name, defaultPrice) {
  const uid = userId || await currentUserId()
  if (!uid) throw new Error('Not authenticated')
  const { data, error } = await supabase
    .from('addons')
    .insert({ user_id: uid, name, default_price: defaultPrice })
    .select()
    .single()
  if (error) { console.error('[LawnBid] createAddon error:', error); throw error }
  return data
}

export async function updateAddon(id, name, defaultPrice) {
  const { error } = await supabase
    .from('addons')
    .update({ name, default_price: defaultPrice })
    .eq('id', id)
  if (error) { console.error('[LawnBid] updateAddon error:', error); throw error }
}

export async function deleteAddon(id) {
  const { error } = await supabase
    .from('addons')
    .delete()
    .eq('id', id)
  if (error) { console.error('[LawnBid] deleteAddon error:', error); throw error }
}
