# Contact Manager

A single-page contact manager (`index.html`) — no build step, just open it in a browser.

## Features
- Add, view, favorite, duplicate and delete contacts
- **Edit in place**: select a contact and click Edit or any field to update it right in the detail view (Enter to save, Esc to cancel, warns before discarding unsaved changes)
- Search by name, phone, email, company or tag; filter by favorites and tags
- **Import** vCard (.vcf), CSV (Google / Outlook / generic) or JSON — one contact or many, with preview and duplicate skipping
- **Export** a single contact or all contacts as CSV, JSON or vCard
- **Bottom navigation** with *Duplicate numbers* and *Duplicate names* views: find matches, choose which contact to keep, and merge
- Responsive layout for desktop and mobile, light and dark mode

## Storage
Contacts are saved in the browser's `localStorage`. When hosted as a Claude artifact, they are saved privately to the viewer's Claude account instead.

## Run locally
Open `index.html` in any modern browser, or serve the folder:
```
python3 -m http.server 8000
```
