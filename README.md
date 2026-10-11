# Stock Line 456

LINE group bot for recording daily sales, physical stock counts, and equipment checks in Google Sheets, then sending a daily Flex summary.

## What it handles

- Sales reports with cash, QR, delivery, and other payment totals. A mismatch is saved and marked `CHECK` by the existing sheet formulas.
- Stock counts saved to `STOCK.closing_reported`; the existing calculated closing, variance, minimum stock, and status formulas are preserved.
- Equipment checks with `OK`, `CHECK`, or `BROKEN` status.
- LINE webhook signature validation, event deduplication in Firestore, and a daily LINE Flex summary.

## LINE message formats

```text
ยอดขาย 12500 สด 7000 QR 3000 delivery 1500 อื่น 1000 กะ เย็น
นับ ITEM-001 18
เช็ค EQ-001 ปกติ
เช็ค EQ-001 ชำรุด สายไฟชำรุด
```

`ITEM_MASTER` and `EQUIPMENT_MASTER` must contain the item/equipment codes before their reports can be accepted. Set `active` to `TRUE` for records included in the daily checklist. `display_name` is left blank; the LINE user ID is stored for attribution.

## Deploy from GitHub to Cloud Run

1. In Google Cloud, select the project that owns the Cloud Run service and enable Cloud Run, Cloud Build, Firestore, Sheets, and Secret Manager APIs.
2. Open **Cloud Run → Connect repository**, connect this GitHub repository, and select the deployment branch. Choose source deployment with the Node.js buildpack. Cloud Run can build and deploy this repository automatically when commits are pushed.
3. Configure the Cloud Run service to accept public HTTPS requests so LINE can reach it. The app verifies the `x-line-signature` header before handling events. Set the service's runtime service account to a dedicated account with Firestore access; share the Google Sheet with that account as an editor.
4. Add these non-secret environment variables:

   | Name | Value |
   | --- | --- |
   | `SPREADSHEET_ID` | ID from the Google Sheets URL |
   | `TIME_ZONE` | `Asia/Bangkok` |
   | `LINE_GROUP_ID` | Target group ID, after the first group webhook has been received |

5. Add these values from Secret Manager as Cloud Run secrets, never as GitHub files or source code:

   | Environment variable | Secret value |
   | --- | --- |
   | `LINE_CHANNEL_SECRET` | Messaging API channel secret |
   | `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API channel access token |
   | `REPORT_JOB_TOKEN` | A newly generated long random value |

   Grant the Cloud Run service account permission to access these secrets.
6. Confirm `GET https://<cloud-run-service>/healthz` returns `200`. Configure the LINE Messaging API webhook as `https://<cloud-run-service>/line/webhook`, then press **Verify** and require success before enabling webhook use. The webhook accepts LINE's empty verification event and returns `200`.
7. In LINE Developers, enable **Allow bot to join group chats** and invite the LINE Official Account to the target group. Send a first message in the group; read its `group_id` from `LINE_LOG`, set `LINE_GROUP_ID` in Cloud Run, and deploy the new revision. Only then use the report commands above.
8. To send the daily Flex report, create a Cloud Scheduler job that POSTs to `https://<cloud-run-service>/admin/daily-summary` at the closing time and supplies `Authorization: Bearer <REPORT_JOB_TOKEN>`.

The LINE Messaging API channel has one webhook URL. Updating it replaces the previous URL. Do not put channel secrets, tokens, the spreadsheet ID, or production event logs in this repository.

## Sheets

This service expects the existing tabs and headers described in [`sheets-schema.csv`](./sheets-schema.csv). The workbook setup has already been run on the target sheet. The Apps Script setup source is intentionally not included here because it is not required by Cloud Run and should remain in the bound Apps Script project.

## Endpoints

- `GET /healthz` — health check
- `POST /line/webhook` — LINE webhook with HMAC signature validation
- `POST /admin/daily-summary` — sends the daily Flex summary; requires the configured bearer token
