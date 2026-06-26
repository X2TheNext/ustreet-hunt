create table if not exists hunters (id uuid primary key references auth.users, display_name text, phone text, total_points int default 0, spin_tokens int default 0, created_at timestamptz default now());
create table if not exists stamps (id serial primary key, user_id uuid references hunters(id), checkpoint_id text not null, points_earned int default 0, scanned_at timestamptz default now());
create unique index if not exists stamps_user_checkpoint on stamps(user_id, checkpoint_id);
