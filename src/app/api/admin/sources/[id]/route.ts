import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { getSupabaseAdmin, SOURCES_BUCKET } from "@/lib/supabase";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthenticatedRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = getSupabaseAdmin();

  const { data: source, error: fetchError } = await supabase
    .from("sources")
    .select("storage_path")
    .eq("id", id)
    .single();

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 404 });
  }

  if (source?.storage_path) {
    await supabase.storage.from(SOURCES_BUCKET).remove([source.storage_path]);
  }

  // chunks cascade-delete via the foreign key ON DELETE CASCADE (see schema.sql)
  const { error: deleteError } = await supabase.from("sources").delete().eq("id", id);
  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
