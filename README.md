# Welcome to your Lovable project

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Open your project in the [Lovable editor](https://lovable.dev) and keep building.

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: connect the project to GitHub and every change made in Lovable is committed straight to your repository.
- **Full ownership**: this code is yours. Push to your repository and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS

## POS order handling

The POS cart's **Checkout** action opens a payment modal where staff choose Cash
or GCash and confirm payment before submitting. New orders are recorded as paid
and completed immediately; they do not enter a prep queue. Existing unpaid
tickets remain visible in **Orders**, where they can be edited or voided.
Orders show a ticket as paid only after the POS records its payment in Supabase.

Menu cards use each menu item's `image_url` when set and fall back to a
category-toned initials badge. Managers and admins can choose **Edit photos** in
the POS to upload a JPEG, PNG, WebP, or AVIF image (up to 5 MB), save a public
image URL, or use an asset path such as `/images/iced-latte.jpg`. Uploads use
the `menu-photos` Supabase Storage bucket.

The **Orders** view shows a date-filtered daily sales report in Asia/Manila time,
with collected tender totals, discounts, void totals, cashier shift totals, and
the day's chronological order list. Selecting a ticket opens its full item
breakdown and available actions.

GCash checkout reads the official merchant QR image from
`VITE_GCASH_QR_IMAGE_URL`. Configure it with a public URL to the cafe's genuine
merchant QR before using it for customer payments. Without that setting, the UI
shows a notice instead of a scannable QR and disables GCash checkout. Set the
variable in `.env` (or `.env.local`) and restart the dev server. The GCash
transaction reference is optional. Cash checkout records the amount received.

## Production, email alerts and database backups

Railway uses the Node server bundle built by `bun run build`; `scripts/start.mjs`
binds to Railway's `PORT` and falls back to `8080`. Configure values from
`.env.example` in Railway's Variables tab. Configure a network-reachable MySQL
`DATABASE_URL` and production `SESSION_SECRET`. SMTP settings power low-stock/
expiry alerts after inventory changes, critical void alerts, and the admin-
triggered daily X-Read email.

The Clock page uses the browser camera and locally shipped face-api models.
Each staff member can enroll from the page; descriptors stay in the restricted
`staff_face_descriptors` table and are matched on the server. An admin can use
their own PIN to authorize a logged attendance override. Use HTTPS and follow
applicable staff biometric-consent and retention requirements.

Admins can create and restore encrypted logical application backups from the
Audit page. The download includes face templates, so protect both the file and
its passphrase. Restore is a merge: it restores missing rows and replaces rows
with matching IDs, but does not delete database rows absent from the backup.
The `cantilounge_xampp.sql` file is the importable MySQL/MariaDB schema for
local XAMPP use.

Managers and admins can use **Manage menu** to add drinks or food with a price,
category, and prep station. Removing an item archives it from the POS when it
already appears on tickets or ingredient recipes, preserving those records;
otherwise the unused menu row is deleted. Archived items can be restored.

Import `cantilounge_xampp.sql` into XAMPP's MySQL database before using the app.
