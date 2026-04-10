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

export async function upsertQuote(quote) {
  // Strip internal-only fields before saving
  const { isNew, existingId, parentId, saveClient, sentAt, clientId, ...rest } = quote
  const record = {
    ...rest,
    parent_id: parentId || null,
    user_id: await currentUserId(),
  }
  // Remove undefined/function values that Supabase can't store
  Object.keys(record).forEach(k => { if (record[k] === undefined || typeof record[k] === 'function') delete record[k] })
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
  'follow_up_days','follow_up_enabled','language',
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

    const payload = {
      zip_prefix: zipPrefix,
      area_sqft: Math.round(quote.area_sqft) || null,
      perimeter_ft: Math.round(quote.linear_ft) || null,
      complexity: quote.complexity || 1.0,
      risk: quote.risk || 1.0,
      crew_size: quote.crew_size || 1,
      est_minutes: quote.est_minutes || null,
      final_price: quote.final_price || null,
      price_per_sqft: quote.area_sqft
        ? Math.round((quote.final_price / quote.area_sqft) * 10000) / 10000
        : null,
      discount_pct: quote.discount_pct || 0,
      is_recurring: quote.is_recurring || false,
      recurring_frequency: quote.recurring_frequency || null,
      outcome,
      declined_reason: quote.declined_reason || null,
      quote_month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      season,
    }

    await supabase.from('market_data').insert(payload)
  } catch (e) {
    // Silent fail — never block the user flow for data collection
    console.log('[Market data] Collection skipped:', e.message)
  }
}
