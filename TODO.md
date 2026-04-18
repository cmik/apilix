# Apilix — Todo / Tech Debt

## Testing

### [ ] Add StatusBar component render tests

**Context:** The startup version-check feature added conditional rendering to `StatusBar` (update badge). Tests were deferred because the Vitest setup does not currently support JSX rendering.

**What's needed:**
1. Install `@testing-library/react` and `jsdom` as dev dependencies in `client/`.
2. Update `client/vitest.config.ts`:
   - Set `environment: 'jsdom'`
   - Extend `include` glob to `src/**/*.test.{ts,tsx}`
3. Create `client/src/components/StatusBar.test.tsx` with:
   - **No update props** → update link absent
   - **`updateAvailable=true, latestVersion="1.2.3"`** → link rendered with correct `href` and text
   - **`updateAvailable=false, latestVersion="1.2.3"`** → link absent even when version is provided
