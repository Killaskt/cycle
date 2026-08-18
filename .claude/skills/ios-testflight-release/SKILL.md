---
name: ios-testflight-release
description: "Use when: preparing, triggering, diagnosing, or distributing the Tortoise Method iOS TestFlight build through Codemagic."
---

# Tortoise Method TestFlight Release

## Preconditions

- The release branch is merged to `master`; `codemagic.yaml` triggers `ios-testflight` on a push to that branch.
- Codemagic app **Tortoise Method IOS** is connected to `github.com/Killaskt/cycle`.
- Codemagic group `tortoise_method_production` provides `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- Codemagic group `tortoise_method_app_store` provides these secret values from an App Store Connect API key:
  - `APP_STORE_CONNECT_KEY_ID`
  - `APP_STORE_CONNECT_ISSUER_ID`
  - `APP_STORE_CONNECT_PRIVATE_KEY` (the complete `.p8` file contents)
- Apple Developer has an App Store signing profile for `com.tortoisemethod.app`, available to Codemagic.
- App Store Connect has a Tortoise Method app record with bundle ID `com.tortoisemethod.app`.

## Release Flow

1. Confirm the PR checks are green with `gh pr view <number> --json statusCheckRollup`.
2. Merge the PR into `master`; Codemagic should automatically trigger the `ios-testflight` workflow.
3. If a manual run is needed, open the Codemagic app, select **Start new build**, choose `master`, select **Tortoise Method iOS (TestFlight)**, and start the build.
4. On success, wait for App Store Connect processing, then add the tester under TestFlight and install using Apple's TestFlight app.

## Failure Triage

- `No matching profiles found` means Codemagic lacks an App Store signing profile for `com.tortoisemethod.app`.
- Missing `APP_STORE_CONNECT_*` values means the TestFlight upload credentials were not added to `tortoise_method_app_store`.
- UI/auth tests failing with missing `VITE_SUPABASE_*` values means the CI `npm test` step lost its local Supabase environment.