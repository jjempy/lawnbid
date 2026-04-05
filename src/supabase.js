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
  const { error } = await supabase
    .from('quotes')
    .upsert(record, { onConflict: 'quote_id' })
  if (error) throw error
}

export async function deleteQuote(quoteId) {
  const { error } = await supabase
    .from('quotes')
    .delete()
    .eq('quote_id', quoteId)
  if (error) throw error
}

export async function updateQuoteStatus(quoteId, status, extraFields = {}) {
  const { error } = await supabase
    .from('quotes')
    .update({ status, updated_at: new Date().toISOString(), user_id: await currentUserId(), ...extraFields })
    .eq('quote_id', quoteId)
  if (error) throw error
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
  const { error } = await supabase
    .from('clients')
    .upsert(record, { onConflict: 'id' })
  if (error) throw error
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

export async function saveSettings(settings) {
  const { id: _id, ...rest } = settings
  const { error } = await supabase
    .from('settings')
    .upsert({ id: 1, ...rest, user_id: await currentUserId() }, { onConflict: 'id' })
  if (error) throw error
}

// ─── Quote Attachments ────────────────────────────────────────────────────────────
const ATTACH_BUCKET = 'quote-attachments'

export async function uploadQuoteFile(quoteId, file) {
  const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const path = `quotes/${quoteId}/${Date.now()}-${cleanName}`
  const { error } = await supabase.storage
    .from(ATTACH_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false })
  if (error) throw error
  const { data } = supabase.storage.from(ATTACH_BUCKET).getPublicUrl(path)
  return { path, url: data.publicUrl }
}

export async function deleteQuoteFile(path) {
  if (!path) return
  const { error } = await supabase.storage.from(ATTACH_BUCKET).remove([path])
  if (error) console.warn('Could not delete attachment:', error.message)
}

// ─── Quote ID ─────────────────────────────────────────────────────────────────────
export async function nextQuoteId() {
  const { data, error } = await supabase.rpc('next_quote_id')
  if (error) throw error
  return data
}
