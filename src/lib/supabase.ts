import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

// Server-side only: uses the service-role key, which bypasses row-level
// security. Never import this file from client components.
export function getSupabaseAdmin(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (see .env.local.example)"
      );
    }
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

export const SOURCES_BUCKET = "sources";
