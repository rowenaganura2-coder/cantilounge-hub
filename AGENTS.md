<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## CantiLounge Hub
- Staff sign in with staff code + PIN mapped to a derived email/password (src/lib/staff-auth.ts); staff accounts are only created server-side — keeps PINs hashed by auth and no public sign-up.
- Orders are placed only through the `place_order` database function with a client-generated `client_id` — makes order + stock deduction atomic and offline replays idempotent.
- POS menu and the offline order queue live in IndexedDB (Dexie, src/lib/offline-db.ts) — lets the till work without internet.
- Roles live in `user_roles`, checked via `has_role`/`has_any_role`/`is_manager` — prevents privilege escalation.
