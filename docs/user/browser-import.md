# Import browser sessions

The desktop app can import cookies from another browser so you can reuse its signed-in sessions
in the preview browser.

Open **Settings → Integrations → Browser profiles → Add profile**, then choose a browser under
**Import from**. Allow an operating-system keyring unlock prompt if one appears. On macOS and
Linux, Chromium-based browsers such as Chrome, Brave, and Edge can stay open. Close Firefox, and
any browser on Windows, before importing.

**Keep in sync** is on by default. While T3 Code is open, it imports from the same browser
profile again every 15 minutes, so sign-ins you make in that browser reach the T3 profile. A
browser that must be closed to import is skipped while it is open. Sync is one-way: signing out
in T3 Code does not affect the browser, and cookies removed in the browser stay in T3 Code until
you clear the profile. The profile list shows which browser a profile syncs from; choose **Stop
syncing** in the profile's menu to turn it off.

Some sites may still require you to sign in again. The cookies stay on this computer, and the
desktop app uses them for every environment you have added, including browser tools it opens for
them. Import again after adding an environment.

On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag T3 Code into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen T3 Code before the grant applies; reopen
the import wizard afterward. Keep Full Disk Access on while a profile syncs from Safari.

On Windows, import supports Firefox and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported. Partitioned cookies
are skipped on all platforms.
