# Org-1 overview promotion bundle (review before executing)

Source: PR #57 exact reviewed commit. Target: Grafana 13.1.1, org 1 only, dashboard `powershell-mcp-usage` in folder `powershell-mcp`; org 2 is never written. The preview UID is `powershell-mcp-overview-preview`; candidate bytes are `../overview-preview.json`. This is an executable controller-side caller, not the old adapter-only contract. It sends a fixed Python API script over strict-host-key SSH stdin to the existing golem sudo route, reads the protected admin secret only on the host, and never forwards ports or prints credentials. Do not invoke `apply` before independent source/bundle review and visual preview acceptance.

From repository root, inspect without writing:

```sh
python collector/analytics/operations/overview_cli.py inspect --identity C:/Users/aegis/.ssh/aegis_golem_ed25519 --receipt C:/Users/aegis/AppData/Local/hermes/workspace/powershell-mcp-overview-promotion/receipt.json
```

The receipt directory is outside Grafana provisioning and outside the 24-hour scratch cache. Preserve it and restrict access to the operator. After review, `apply` uses the same options and records baseline dashboard JSON, all seven non-target dashboard digests and a pending intent *before* mutation. Replace `inspect` with `apply`; invoke exactly the same `apply` command after an interrupted operation to reconcile the API readback. It refuses unknown outcome or drift rather than blindly issuing another write. Replace `apply` with `rollback` to restore prior dashboard semantics; Grafana's version increments, so rollback is not byte-for-byte version restoration. Keep the receipt permanently. Do not reset or bootstrap target configuration.

The caller checks the authenticated org, folder, live version, exact candidate readback, preview semantic equivalence, and unchanged other dashboards. It does not change the datasource or org 2. Capture the actual frontend at 1440 and 1100 pixels and verify the target dashboard panels after approved promotion; `inspect` and API readback alone do not establish visual acceptance. A write timeout, API normalization mismatch, or non-target drift requires inspecting the durable receipt and live dashboard, not inventing a successful state.
