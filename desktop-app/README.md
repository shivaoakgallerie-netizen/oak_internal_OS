# Oak Desk Windows application

This package creates the internal Windows installer for Oak Desk. The application loads the production Netlify URL in an isolated Electron window. It does not contain Supabase service credentials or change the database.

Build from this directory with `npm install` followed by `npm run build:win`. The installer is written to `release/Oak-Desk-Setup-1.0.0.exe`.

The installer is unsigned until Oak Gallerie configures a Windows code-signing certificate. Windows SmartScreen may therefore show an Unknown publisher warning during internal installation.
