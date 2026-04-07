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
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS follow_up_days integer DEFAULT 3;
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS language text DEFAULT 'en';
// ALTER TABLE settings ADD COLUMN IF NOT EXISTS follow_up_enabled boolean DEFAULT true;
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
export async function loadSettings() {
  const { data, error, status } = await supabase
    .from('settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle()
  // PGRST116 = no rows found; 406 = Not Acceptable (no rows on .single()). Both mean "no settings yet."
  if (error && error.code !== 'PGRST116' && status !== 406) throw error
  return data || null
}

// Known settings columns — only these are sent to Supabase.
// If you add a new column, add it here AND run the ALTER TABLE SQL.
const SETTINGS_COLUMNS = [
  'mow_rate','trim_rate','equipment_cost','hourly_rate','minimum_bid',
  'complexity_default','risk_default','profit_margin','quote_validity_days',
  'follow_up_days','follow_up_enabled','language',
  'company_name','company_phone','company_email','company_logo_base64',
  'plan','quote_count_this_month','quote_count_reset_at',
]
export async function saveSettings(settings) {
  const record = { id: 1, user_id: await currentUserId() }
  for (const k of SETTINGS_COLUMNS) {
    if (settings[k] !== undefined && typeof settings[k] !== 'function') record[k] = settings[k]
  }
  const { error } = await supabase
    .from('settings')
    .upsert(record, { onConflict: 'id' })
  if (error) { console.error('[LawnBid] saveSettings error:', error.message, error.details, error.code); throw error }
}

// ─── Quote Attachments ────────────────────────────────────────────────────────────
const ATTACH_BUCKET = 'quote-attachments'

export async function uploadQuoteFile(quoteId, file) {
  const userId = await currentUserId()
  if (!userId) throw new Error('Not authenticated')
  const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const path = `${userId}/${quoteId}/${Date.now()}-${cleanName}`
  const { error } = await supabase.storage
    .from(ATTACH_BUCKET)
    .upload(path, file, { contentType: file.type, cacheControl: '3600', upsert: false })
  if (error) {
    const msg = (error.message || '').toLowerCase()
    if (msg.includes('bucket not found') || msg.includes('the resource was not found')) {
      throw new Error('Photo storage is not configured. Please contact support.')
    }
    throw error
  }
  const { data } = supabase.storage.from(ATTACH_BUCKET).getPublicUrl(path)
  return { path, url: data.publicUrl }
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
