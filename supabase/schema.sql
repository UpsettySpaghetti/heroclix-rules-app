-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query)
-- for a fresh project. Safe to re-run: everything is IF NOT EXISTS / OR REPLACE.

create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  kind text not null check (kind in ('file', 'link')),
  origin_url text,
  storage_path text,
  added_at timestamptz not null default now()
);

-- 1024 matches Voyage AI's voyage-3.5 embedding model (src/lib/embeddings.ts).
-- If you change EMBEDDING_MODEL there, update this dimension to match.
create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete cascade,
  content text not null,
  embedding vector(1024) not null,
  chunk_index int not null,
  label text
);

-- HNSW, not IVFFlat: IVFFlat is a clustering-based index that needs a
-- reasonably large, stable dataset to place vectors into useful clusters -
-- on a small/growing table (exactly this app's situation) it can silently
-- miss rows that are genuinely the best match. HNSW has no such cold-start
-- problem and stays accurate as the corpus grows.
create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);

create index if not exists chunks_source_id_idx on chunks (source_id);

-- Used by src/app/api/ask/route.ts to find the most relevant excerpts for a
-- visitor's question via cosine similarity.
-- `create or replace` can't change a function's return columns, only its
-- body - so this drops it first, making it safe to re-run after the
-- returned columns change (as opposed to just its logic).
drop function if exists match_chunks(vector, int);

create or replace function match_chunks(query_embedding vector(1024), match_count int)
returns table (
  id uuid,
  source_id uuid,
  content text,
  label text,
  similarity float,
  source_title text,
  origin_url text,
  source_kind text,
  storage_path text
)
language sql stable
as $$
  select
    chunks.id,
    chunks.source_id,
    chunks.content,
    chunks.label,
    1 - (chunks.embedding <=> query_embedding) as similarity,
    sources.title as source_title,
    sources.origin_url as origin_url,
    sources.kind as source_kind,
    sources.storage_path as storage_path
  from chunks
  join sources on sources.id = chunks.source_id
  order by chunks.embedding <=> query_embedding
  limit match_count;
$$;

-- Row Level Security: the app only ever talks to Supabase using the
-- service-role key from server-side code, which bypasses RLS entirely.
-- Enabling it here just makes sure these tables are never reachable using
-- the public anon key, in case one is added to this project later.
alter table sources enable row level security;
alter table chunks enable row level security;

-- Private storage bucket for the original uploaded files (PDFs, DOCX, etc).
insert into storage.buckets (id, name, public)
values ('sources', 'sources', false)
on conflict (id) do nothing;
