# Running CantiLounge Hub on your computer

You need **XAMPP** plus one of these installed:

- **Bun** (recommended - the project ships with a `bun.lock` file)
- **Node.js 20.19+ or 22.12+** (use `npm` in place of `bun`)

## 1. Install the packages

Open a terminal in the `cantilounge-hub` folder and run:

```sh
bun install
```

With npm, run `npm install`.

## 2. Start XAMPP and import the database

In XAMPP Control Panel, start **Apache** and **MySQL**. Open
`http://localhost/phpmyadmin`, choose **Import**, and select
`cantilounge_xampp.sql`. This creates or updates the `cantilounge_hub` database.

The app uses the standard XAMPP connection by default: `127.0.0.1:3306`,
database `cantilounge_hub`, user `root`, and a blank password. If you changed
the MySQL password or port, set `DATABASE_URL` in `.env`, using the format in
`.env.example`.

## 3. Start the app

```sh
bun run dev
```

With npm, use `npm run dev`. Open the local address printed in the terminal,
usually `http://localhost:5173`.

The first visit lets you create the owner account using your name, a staff
code, and a 4-6 digit PIN. The SQL import includes the sample cafe menu: four
categories, 12 menu items, 13 ingredients, and their recipes. You can edit
these in the app after signing in.

## Other commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Run it for day-to-day work, with hot reload |
| `bun run build` | Make the production version |
| `bun run preview` | Run the production build locally to check it |
| `bun test` | Run the automated tests |
| `bun run lint` | Check code style |
| `bun run format` | Fix code style |

## Configuration and deployment

Email alerts require `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, and
`OWNER_ALERT_EMAIL`. Face enrollment requires camera permission; staff
descriptors are biometric data and should be handled under your organization's
consent and retention policies.

Admins can download a passphrase-encrypted logical backup or restore a backup
from the Audit page. Restore merges rows and does not remove newer rows missing
from the file.

For Railway or another remote host, configure a network-reachable MySQL
`DATABASE_URL` and a production `SESSION_SECRET`. The remote host cannot use
your computer's local XAMPP database.

## If something does not start

- If XAMPP MySQL will not start, check whether another service is using port
  `3306`.
- If the app cannot reach the database, make sure XAMPP MySQL is running and
  that `cantilounge_xampp.sql` imported successfully.
- If `bun install` fails, check that Node is version 20.19+ and run
  `bun install` again.
