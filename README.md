# Contact Manager

A single-page contact manager (`index.html`) — no build step, just open it in a browser.

## Copyright

Copyright © 2026 Mahmoud D. All rights reserved. See [`COPYRIGHT`](COPYRIGHT).

## Features
- Add, view, favorite, duplicate and delete contacts
- **Edit in place**: select a contact and click Edit or any field to update it right in the detail view (Enter to save, Esc to cancel, warns before discarding unsaved changes)
- **Multiple selection**: tick several contacts (Select, Ctrl/⌘-click, Shift-click for a range, or long-press on touch) to favorite, tag, set keep-in-touch reminders, export, merge or delete them in one go
- **Recently deleted**: deleted and merged-away contacts are kept for 30 days (Undo right after deleting, Restore or Delete for good later), then removed automatically
- **Country calling codes**: phone fields have a country picker with flags (+224, +1, +33 …); the country is detected from saved numbers, shown as a flag, filterable, and summarised in "Phone numbers by country"; numbers saved without a code use a default country you can change
- **Categories** (Work, Students, Faculty, Vendors, Friends & Family, Alumni, Potential Employers, Important Services, or your own) with colours and a category filter
- **Priority tiers** (Key contact every 30–60 days, Active project weekly, General networking every 3–6 months) that set the keep-in-touch reminder
- **Follow-ups**: next follow-up date and note per contact, shown in a Contact / Role / Last contact / Next follow-up table on Reminders with Done and +1 week
- **Conversation notes**: log what was discussed, promises made and the next action (which sets the follow-up)
- **Weekly review** (10 minutes): add new contacts, update notes, check follow-ups, remove duplicates, reconnect with 2–3 important people — plus a monthly clean-up to archive inactive contacts, check key professional contacts and fill missing details
- **Archive** and **checked on** dates for contacts; **Outlook CSV** export for Outlook People / Microsoft Contacts
- **Share a contact** (or several): QR code the other phone scans, the device share menu (Wi-Fi, Bluetooth, AirDrop, Nearby Share) when the page is opened directly in a browser, WhatsApp, Gmail, Outlook, email app, Telegram, or copy as text/vCard — choosing which details to include
- Search by name, phone, email, company or tag; filter by favorites and tags
- **Import** vCard (.vcf), CSV (Google / Outlook / generic) or JSON — one contact or many, with preview and duplicate skipping
- **Export** a single contact or all contacts as CSV, JSON or vCard
- **Bottom navigation** with *Duplicate numbers* and *Duplicate names* views: find matches, choose which contact to keep, and merge; large result sets load progressively to keep the view responsive
- **Photo or icon** for each contact: upload or take a photo (auto-cropped and compressed), or pick an emoji icon and background colour; photos are imported from and exported to vCards
- **Relationship tracking**: log calls, emails, meetings, messages and notes with a date and short note; "how you met" and "introduced by" fields (linked to the introducer's contact)
- **Reminders** tab: birthday and anniversary alerts for the next 14 days, "keep in touch" nudges (e.g. every 30 days) when you haven't been in contact, and fading relationships
- **Relationship strength** score (0–100) from how often and how recently you interact
- **Smarter duplicates**: "J. Smith" and "John Smith" are matched when their email is the same
- **Scan** tab: bring in your phone's address book (contact picker on Android Chrome, or an exported .vcf file with step-by-step export help for iPhone, Android, Google and Mac), then optionally scan your sent Gmail for people you email who aren't saved yet
- **Business card scanning** (when hosted on Claude): snap a card and Claude fills in a new contact for you to check
- **Gmail & Google Calendar sync** (when hosted on Claude, using the viewer's own connectors): emails and meetings from the last year are logged automatically
- Responsive layout for desktop and mobile, light and dark mode

## Appointment requests
`appointment.html` is a public form people reach by scanning `appointment-qr-card.png` (or `appointment-qr.svg`). Requests are emailed to you via FormSubmit; the first request triggers a one-time activation email from FormSubmit that must be confirmed.

## Storage
By default, contacts are saved in the browser's `localStorage`. When hosted as a Claude artifact, they are saved privately to the viewer's Claude account. When this page is served from the same origin as the configured backend and you sign in, contacts are stored in your server-side account. Any pre-existing browser contacts are preserved and can be copied into the account from the sync panel.

## Account and contact sync
The page includes Google and Microsoft sign-in, account storage, and two-way Google Contacts, Microsoft Outlook / 365, and Apple iCloud Contacts sync. Sync always shows a preview and requires a choice for each conflict. The API, Postgres schema, provider integrations, container setup, and security notes are in [`backend/`](backend/README.md).

For production, serve this page and the API from the same HTTPS origin. Route `/api/*` and `/auth/*` to the backend and serve the static website for `/`; configure the OAuth callback URLs and secrets in the backend environment. The backend package is deploy-ready but is not deployed by this repository, and live sync requires provider credentials and a configured database.

## Run locally
Open `index.html` in any modern browser, or serve the folder:
```
python3 -m http.server 8000
```
