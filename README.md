# Contact Manager

A single-page contact manager (`index.html`) — no build step, just open it in a browser.

## Features
- Add, view, favorite, duplicate and delete contacts
- **Edit in place**: select a contact and click Edit or any field to update it right in the detail view (Enter to save, Esc to cancel, warns before discarding unsaved changes)
- **Multiple selection**: tick several contacts (Select, Ctrl/⌘-click, Shift-click for a range, or long-press on touch) to favorite, tag, set keep-in-touch reminders, export, merge or delete them in one go
- **Recently deleted**: deleted and merged-away contacts are kept for 30 days (Undo right after deleting, Restore or Delete for good later), then removed automatically
- **Country calling codes**: phone fields have a country picker with flags (+224, +1, +33 …); the country is detected from saved numbers, shown as a flag, filterable, and summarised in "Phone numbers by country"; numbers saved without a code use a default country you can change
- Search by name, phone, email, company or tag; filter by favorites and tags
- **Import** vCard (.vcf), CSV (Google / Outlook / generic) or JSON — one contact or many, with preview and duplicate skipping
- **Export** a single contact or all contacts as CSV, JSON or vCard
- **Bottom navigation** with *Duplicate numbers* and *Duplicate names* views: find matches, choose which contact to keep, and merge
- **Photo or icon** for each contact: upload or take a photo (auto-cropped and compressed), or pick an emoji icon and background colour; photos are imported from and exported to vCards
- **Relationship tracking**: log calls, emails, meetings, messages and notes with a date and short note; "how you met" and "introduced by" fields (linked to the introducer's contact)
- **Reminders** tab: birthday and anniversary alerts for the next 14 days, "keep in touch" nudges (e.g. every 30 days) when you haven't been in contact, and fading relationships
- **Relationship strength** score (0–100) from how often and how recently you interact
- **Smarter duplicates**: "J. Smith" and "John Smith" are matched when their email is the same
- **Scan** tab: bring in your phone's address book (contact picker on Android Chrome, or an exported .vcf file with step-by-step export help for iPhone, Android, Google and Mac), then optionally scan your sent Gmail for people you email who aren't saved yet
- **Business card scanning** (when hosted on Claude): snap a card and Claude fills in a new contact for you to check
- **Gmail & Google Calendar sync** (when hosted on Claude, using the viewer's own connectors): emails and meetings from the last year are logged automatically
- Responsive layout for desktop and mobile, light and dark mode

## Storage
Contacts are saved in the browser's `localStorage`. When hosted as a Claude artifact, they are saved privately to the viewer's Claude account instead.

## Run locally
Open `index.html` in any modern browser, or serve the folder:
```
python3 -m http.server 8000
```
