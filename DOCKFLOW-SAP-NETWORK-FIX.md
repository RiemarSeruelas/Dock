# DockFlow Receiving Records access fix

This update makes Receiving Records use DockFlow's existing account-role permissions by default. It no longer rejects an authorized SAP Analyst, Administrator, Planner, or Warehouse account merely because the workstation is connected through a different company Wi-Fi route.

The PostgreSQL connection and data are unchanged. Supplier accounts remain blocked from the SAP endpoints, and the existing per-column edit permissions remain enforced.

## Install on the hosting workstation

1. Stop DockFlow or leave it running while copying the files.
2. Extract this ZIP over the DockFlow project root and allow the included files to be replaced.
3. Keep the host's existing `.env`, `data`, uploads, and PostgreSQL database.
4. Add this explicit setting to the existing `.env`:

   ```env
   SAP_NETWORK_RESTRICTION_ENABLED=false
   ```

   Existing `SAP_ALLOWED_CIDRS` and `SAP_TRUSTED_PROXY_CIDRS` values may remain. They are ignored while the setting above is `false`.

5. Rebuild and restart from the DockFlow project directory:

   ```powershell
   docker compose up -d --build --force-recreate
   ```

6. Confirm the running API received the setting:

   ```powershell
   docker compose exec api printenv SAP_NETWORK_RESTRICTION_ENABLED
   ```

   The result should be `false`.

7. Sign out, refresh the browser, and sign in again with a SAP Analyst account. Receiving Records should load from PostgreSQL on either approved company Wi-Fi connection, provided the hosting workstation can reach PostgreSQL.

## Optional network restriction

To require both an authorized role and an allowed client network later, set:

```env
SAP_NETWORK_RESTRICTION_ENABLED=true
SAP_ALLOWED_CIDRS=the_actual_client_or_vpn_cidrs
SAP_TRUSTED_PROXY_CIDRS=only_proxies_that_sanitize_forwarded_headers
```

Then rebuild the containers. Do not enable this mode until the hosting team confirms the real client, VPN, and proxy CIDRs.

## If the page still shows no data

Check the API logs from the hosting workstation:

```powershell
docker compose logs --tail=200 api
```

At that point the likely issue is the API-to-PostgreSQL connection or PostgreSQL credentials—not the user's Wi-Fi address.
