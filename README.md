# Tasket

Tasket is a responsive task and productivity dashboard for organizing school, work, and personal tasks. It is built with vanilla HTML, CSS, and JavaScript, with Supabase as an optional cloud sync service. No AI/ML features are used.

## Features

- Create, edit, delete, and complete tasks with a category, priority, due date, description, and status.
- Search task titles; filter by category, priority, and status; sort by due date, priority, or recently added.
- See task totals, in-progress and completed counts, overall completion, and deadline indicators.
- Keep user tasks in browser `localStorage` between visits.
- Optionally create an account and sync tasks across devices with Supabase; local task use still works without an account.
- Browse independent sample tasks from DummyJSON and add selected ideas without replacing saved tasks.
- Fetch daily inspiration from the Advice Slip API, with a friendly error state if a request fails.
- Export and import tasks as JSON, clear completed tasks, and switch between light and dark themes from the sidebar or top bar.
- Add checklist subtasks, favorite tasks, and organize due dates in a month calendar.
- Optionally view local weather from Open-Meteo after granting browser location permission.
- Responsive layout and accessible task controls.

## Technologies and APIs

- HTML, CSS, and vanilla JavaScript (Fetch API, Promises/async-await, DOM events)
- [DummyJSON Todos API](https://dummyjson.com/docs/todos) for optional sample tasks
- [Advice Slip API](https://api.adviceslip.com/) for daily inspiration
- Browser `localStorage` for tasks and theme preference
- [Supabase Auth and Postgres](https://supabase.com/docs) for optional cross-device task sync
- [Open-Meteo](https://open-meteo.com/) for optional local weather (uses browser location permission; no API key required)

The advice and sample-task API integrations are public and do not require API keys. Tasket does not send locally saved tasks to either API. Sample tasks are fetched separately and only saved when the user explicitly adds one. Supabase cloud sync is disabled until you configure your own project.
Weather is an optional widget; it requests your location only after you press **Use my location**, and sends coordinates to Open-Meteo to retrieve current conditions. Weather is not available unless the browser grants location access and the network request succeeds.

## Supabase, in plain language

Supabase is the online place where Tasket can store tasks so the same account can see them on another device. The **Project URL** is the address of that online project. The **Publishable key** tells Supabase which browser app is making the request; it is designed to be visible in front-end code, not treated like a password. A user still signs in, and the database rules in `supabase-schema.sql` restrict that user to their own tasks. The app does not need a service-role/secret key.

## Configure optional cloud sync

1. Go to [supabase.com](https://supabase.com/) and sign in or create an account. Choose **New project**, name it `Tasket`, choose the **Free** plan, select a nearby region if offered, and create a database password. Save that database password somewhere private; Tasket does not use it.
2. Wait for Supabase to finish creating the project. In its dashboard, open **SQL Editor → New query**. Open [`supabase-schema.sql`](./supabase-schema.sql) in this folder, copy all its contents into the query, and choose **Run**. This creates the task table and access rules.
3. In the dashboard's **Connect** dialog or **Project Settings → API Keys**, copy the **Project URL** and **Publishable key** (it starts with `sb_publishable_`).
4. Open [`supabase-config.js`](./supabase-config.js) in this project. Paste the values between the quotes:

   ```js
   window.TASKFLOW_SUPABASE_CONFIG = {
     url: "https://your-project-id.supabase.co",
     publishableKey: "sb_publishable_your_key"
   };
   ```

5. In Supabase **Authentication** settings, enable the **Email** provider. Set the allowed site URL to your app address. For local testing, use the exact address shown by VS Code Live Server (often `http://127.0.0.1:5500`); add the deployed website address after deployment. If email confirmation is enabled, confirm the message sent to your inbox.
6. Open Tasket using Live Server and choose **Sign in to sync → Create account**. Create an email/password account, then sign in. New tasks and edits sync to Supabase; deletions sync as markers so an older cached copy on another device does not restore a deleted task. On another device, open the same deployed site and sign in to the same Tasket account. Use **Sync now** to fetch changes made while an already-open page was idle.

The publishable key is intended for browser use; it identifies this app but does not identify a signed-in user. Supabase Auth identifies each user, and row-level security decides which task rows that user can access. Never put a Supabase secret or legacy `service_role` key in this project. Keep row-level security enabled. The app retains local browser storage as a cache and continues to work if Supabase is not configured or temporarily unavailable.

If you already ran an earlier version of the schema before adding favorites and subtasks, run the updated `supabase-schema.sql` again in the SQL Editor. Its `add column if not exists` statements add the new fields without removing existing task data.

## State and API flow

- The in-memory `tasks` array is the UI state; each change re-renders the task list and dashboard statistics.
- Task edits, favorite state, and subtask checklists are persisted to `localStorage` immediately. When signed in, a queued asynchronous Supabase upsert runs as well, so rapid edits are sent in order.
- Cloud records use `updated_at` for last-write-wins conflict resolution. Deletions are stored as tombstones so an older cached copy on another device does not bring a deleted task back.
- The quote and sample-task widgets use `fetch` with `async`/`await`. API errors are caught and reported in their widgets without blocking task management.
- Supabase row-level security checks `auth.uid()` against `user_id` for every task operation. Guest tasks stay in a separate local-storage key; when a user first signs in, they are merged into that account.

## Run locally

1. Clone or download this repository.
2. Serve the folder using a local web server (for example, VS Code Live Server). This is recommended for Supabase authentication and API access.
3. Allow network access for the quote, sample-task, and Supabase integrations. Without Supabase configuration, task CRUD continues to work locally.

## Deploy

The project is static and can be published using GitHub Pages, Netlify, or Vercel. For GitHub Pages, push the files to a repository, then enable Pages in the repository settings and select the branch/folder containing `index.html`. Add the deployed URL to Supabase Auth's allowed site/redirect URLs.

## Screenshots

Screenshots can be added here after deployment.
