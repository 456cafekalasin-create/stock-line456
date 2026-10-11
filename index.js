const crypto = require('node:crypto');
const http = require('node:http');
const { google } = require('googleapis');
const { Firestore } = require('@google-cloud/firestore');

const PORT = Number(process.env.PORT || 8080);
const TZ = process.env.TIME_ZONE || 'Asia/Bangkok';
const SHEET_ID = required('SPREADSHEET_ID');
const LINE_SECRET = required('LINE_CHANNEL_SECRET');
const LINE_TOKEN = required('LINE_CHANNEL_ACCESS_TOKEN');
const JOB_TOKEN = required('REPORT_JOB_TOKEN');
const LINE_GROUP_ID = process.env.LINE_GROUP_ID || '';

const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
const firestore = new Firestore();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function dateInZone(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function timeInZone(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

function verifySignature(raw, signature) {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', LINE_SECRET).update(raw).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseAmount(text) {
  if (!/^\d+(?:,\d{3})*(?:\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text.replaceAll(',', ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseCommand(text) {
  const sales = text.match(/^ยอดขาย\s+([\d,.]+)\s+สด\s+([\d,.]+)\s+QR\s+([\d,.]+)\s+(?:delivery|เดลิเวอรี่)\s+([\d,.]+)\s+อื่น\s+([\d,.]+)(?:\s+กะ\s+(เช้า|บ่าย|เย็น|ดึก|\S+))?(?:\s+หมายเหตุ\s+(.+))?$/iu);
  if (sales) {
    const [total, cash, qr, delivery, other] = sales.slice(1, 6).map(parseAmount);
    if ([total, cash, qr, delivery, other].some(v => v === null)) return { error: 'จำนวนเงินไม่ถูกต้อง' };
    return { type: 'sales', total, cash, qr, delivery, other, shift: sales[6] || '', note: sales[7] || '' };
  }

  const stock = text.match(/^นับ\s+([A-Za-z0-9_-]+)\s+([\d,.]+)(?:\s+หมายเหตุ\s+(.+))?$/u);
  if (stock) {
    const quantity = parseAmount(stock[2]);
    if (quantity === null) return { error: 'จำนวนสต็อกไม่ถูกต้อง' };
    return { type: 'stock', code: stock[1].toUpperCase(), quantity, note: stock[3] || '' };
  }

  const equipment = text.match(/^เช็ค\s+([A-Za-z0-9_-]+)\s+(OK|CHECK|BROKEN|ปกติ|ชำรุด|ต้องซ่อม)(?:\s+(.+))?$/iu);
  if (equipment) {
    const rawStatus = equipment[2].toUpperCase();
    const status = rawStatus === 'ปกติ' ? 'OK' : rawStatus === 'ชำรุด' ? 'BROKEN' : rawStatus === 'ต้องซ่อม' ? 'CHECK' : rawStatus;
    if (status !== 'OK' && !equipment[3]) return { error: 'ถ้าอุปกรณ์ไม่ปกติ ให้ระบุรายละเอียดต่อท้าย' };
    return { type: 'equipment', code: equipment[1].toUpperCase(), status, note: equipment[3] || '' };
  }
  return { error: 'รูปแบบไม่ตรง กรุณาใช้คำสั่งตามตัวอย่าง' };
}

async function readValues(range) {
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return result.data.values || [];
}

async function appendValues(range, rows) {
  return sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

async function appendWithMetadata(baseRange, values, metadataPrefix, metadata) {
  const result = await appendValues(baseRange, [values]);
  const updatedRange = result.data.updates?.updatedRange || '';
  const match = updatedRange.match(/![A-Z]+(\d+):/);
  if (!match) throw new Error(`Could not identify appended row for ${baseRange}`);
  const rowNumber = match[1];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${metadataPrefix}${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [metadata] },
  });
  return rowNumber;
}

function active(value) {
  return ['TRUE', '1', 'YES', 'ใช่', 'ACTIVE'].includes(String(value).trim().toUpperCase());
}

async function masterRecord(range, code) {
  const rows = await readValues(range);
  return rows.find(row => String(row[0] || '').trim().toUpperCase() === code && active(row[3]));
}

async function reserveEvent(eventId) {
  const ref = firestore.collection('lineWebhookEvents').doc(eventId);
  const claim = await firestore.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const existing = snapshot.exists ? snapshot.data() : null;
    if (existing?.status === 'done') return false;
    if (existing?.status === 'processing' && Date.now() - existing.updatedAt < 120000) return false;
    tx.set(ref, {
      status: 'processing', attempts: (existing?.attempts || 0) + 1,
      updatedAt: Date.now(), createdAt: existing?.createdAt || Date.now(),
    });
    return true;
  });
  return claim ? ref : null;
}

async function lineRequest(path, body) {
  const response = await fetch(`https://api.line.me/v2/bot/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${LINE_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`LINE API returned ${response.status}`);
}

async function replyText(replyToken, text) {
  if (!replyToken) return;
  await lineRequest('message/reply', {
    replyToken, messages: [{ type: 'text', text }],
  });
}

function usageText() {
  return [
    'รายงานยอดขาย: ยอดขาย 12500 สด 7000 QR 3000 delivery 1500 อื่น 1000 กะ เย็น',
    'นับสต็อก: นับ ITEM-001 18',
    'ตรวจอุปกรณ์: เช็ค EQ-001 ปกติ',
    'ถ้าชำรุด: เช็ค EQ-001 ชำรุด สายไฟชำรุด',
  ].join('\n');
}

async function logEvent(event, status, messageText = '', command = null, errorMessage = '') {
  const source = event.source || {};
  const message = event.message || {};
  await appendValues('LINE_LOG!A:M', [[
    new Date(event.timestamp || Date.now()).toISOString(),
    dateInZone(event.timestamp || Date.now()),
    source.groupId || source.roomId || '',
    source.userId || '',
    '',
    message.id || '',
    message.type || event.type || '',
    messageText,
    command?.type || '',
    command ? JSON.stringify(command) : '',
    status,
    errorMessage,
    event.webhookEventId || message.id || '',
  ]]);
}

async function handleMessage(event, eventId) {
  const source = event.source || {};
  const message = event.message || {};
  if (event.type !== 'message' || message.type !== 'text') {
    await logEvent(event, 'ignored_non_text');
    return;
  }
  if (!source.groupId) {
    await replyText(event.replyToken, 'กรุณาส่งรายงานในกลุ่ม LINE ที่กำหนด');
    await logEvent(event, 'rejected_not_group', message.text || '');
    return;
  }
  if (LINE_GROUP_ID && source.groupId !== LINE_GROUP_ID) {
    await replyText(event.replyToken, 'กลุ่มนี้ยังไม่ได้รับอนุญาตให้ส่งรายงาน');
    await logEvent(event, 'rejected_wrong_group', message.text || '');
    return;
  }

  const command = parseCommand(String(message.text || '').trim());
  if (command.error) {
    await replyText(event.replyToken, `${command.error}\n\n${usageText()}`);
    await logEvent(event, 'invalid_format', message.text || '', command, command.error);
    return;
  }

  const timestamp = event.timestamp || Date.now();
  const date = dateInZone(timestamp);
  const time = timeInZone(timestamp);
  const actor = source.userId || '';
  const group = source.groupId;

  if (command.type === 'sales') {
    const payments = command.cash + command.qr + command.delivery + command.other;
    const difference = command.total - payments;
    await appendWithMetadata('SALES!A:J', [
      date, time, group, actor, '', command.total, command.cash,
      command.qr, command.delivery, command.other,
    ], 'SALES!N', [message.text || '', message.id || '', eventId]);
    const status = Math.abs(difference) < 0.01 ? 'OK' : 'CHECK';
    await replyText(event.replyToken, `บันทึกยอดขาย ${date} แล้ว\nยอดขาย ${command.total.toLocaleString('th-TH')} บาท | รับเงิน ${payments.toLocaleString('th-TH')} บาท\nสถานะ ${status}${status === 'CHECK' ? ` (ส่วนต่าง ${difference.toLocaleString('th-TH')} บาท)` : ''}`);
  } else if (command.type === 'stock') {
    const item = await masterRecord('ITEM_MASTER!A2:E', command.code);
    if (!item) {
      await replyText(event.replyToken, `ไม่พบรหัสสินค้า ${command.code} ใน ITEM_MASTER กรุณาเพิ่มรหัสก่อนแล้วส่งใหม่`);
      await logEvent(event, 'unknown_item', message.text || '', command);
      return;
    }
    const name = String(item[1] || '');
    const unit = String(item[2] || 'หน่วย');
    await appendWithMetadata('STOCK!A:M', [
      date, time, group, actor, '', command.code, name, unit, '', '', '', '', command.quantity,
    ], 'STOCK!R', [message.text || '', message.id || '', eventId]);
    await replyText(event.replyToken, `บันทึกนับ ${name} (${command.code}) ${command.quantity} ${unit} แล้ว`);
  } else if (command.type === 'equipment') {
    const item = await masterRecord('EQUIPMENT_MASTER!A2:D', command.code);
    if (!item) {
      await replyText(event.replyToken, `ไม่พบรหัสอุปกรณ์ ${command.code} ใน EQUIPMENT_MASTER กรุณาเพิ่มรหัสก่อนแล้วส่งใหม่`);
      await logEvent(event, 'unknown_equipment', message.text || '', command);
      return;
    }
    const name = String(item[1] || command.code);
    await appendWithMetadata('EQUIPMENT!A:I', [
      date, time, group, actor, '', command.code, name, command.status, command.note,
    ], 'EQUIPMENT!L', [message.text || '', message.id || '', eventId]);
    await replyText(event.replyToken, `บันทึกตรวจ ${name}: ${command.status}${command.note ? ` (${command.note})` : ''}`);
  }
  await logEvent(event, `saved_${command.type}`, message.text || '', command);
}

function flexText(text, size = 'sm', weight = 'regular', color = '#333333') {
  return { type: 'text', text: String(text), size, weight, color, wrap: true };
}

async function dailySummary(date) {
  const [salesRows, stockRows, equipmentRows, itemMaster, equipmentMaster] = await Promise.all([
    readValues('SALES!A2:J'), readValues('STOCK!A2:M'), readValues('EQUIPMENT!A2:N'),
    readValues('ITEM_MASTER!A2:E'), readValues('EQUIPMENT_MASTER!A2:D'),
  ]);
  const sales = salesRows.filter(r => String(r[0]) === date);
  const stock = stockRows.filter(r => String(r[0]) === date);
  const equipment = equipmentRows.filter(r => String(r[0]) === date);
  const sum = col => sales.reduce((n, r) => n + (Number(r[col]) || 0), 0);
  const paymentMismatchCount = sales.filter(r => Math.abs((Number(r[5]) || 0) - [6, 7, 8, 9].reduce((n, col) => n + (Number(r[col]) || 0), 0)) >= 0.01).length;
  const activeItems = itemMaster.filter(r => active(r[3]));
  const activeEquipment = equipmentMaster.filter(r => active(r[3]));
  const counted = new Set(stock.map(r => String(r[5] || '').toUpperCase()));
  const checked = new Set(equipment.map(r => String(r[5] || '').toUpperCase()));
  const issues = equipment.filter(r => r[7] && r[7] !== 'OK');
  const missingItems = activeItems.filter(r => !counted.has(String(r[0] || '').toUpperCase())).length;
  const missingEquipment = activeEquipment.filter(r => !checked.has(String(r[0] || '').toUpperCase())).length;

  const contents = [
    flexText(`สรุปรายงานประจำวัน ${date}`, 'lg', 'bold'),
    { type: 'separator', margin: 'md' },
    flexText(`ยอดขายรวม  ${sum(5).toLocaleString('th-TH')} บาท`, 'md', 'bold'),
    flexText(`สด ${sum(6).toLocaleString('th-TH')} | QR ${sum(7).toLocaleString('th-TH')}`),
    flexText(`delivery ${sum(8).toLocaleString('th-TH')} | อื่น ${sum(9).toLocaleString('th-TH')}`),
    flexText(`รายงานยอดขาย ${sales.length} รายการ`),
    flexText(`ยอดรับเงินไม่ตรง ${paymentMismatchCount} รายการ`, 'sm', paymentMismatchCount ? 'bold' : 'regular', paymentMismatchCount ? '#B42318' : '#333333'),
    { type: 'separator', margin: 'md' },
    flexText(`นับสต็อกแล้ว ${new Set(stock.map(r => String(r[5] || ''))).size}/${activeItems.length} รายการ`),
    flexText(`ยังไม่นับ ${missingItems} รายการ`),
    { type: 'separator', margin: 'md' },
    flexText(`ตรวจอุปกรณ์แล้ว ${checked.size}/${activeEquipment.length} รายการ`),
    flexText(`พบปัญหา ${issues.length} รายการ | ยังไม่ตรวจ ${missingEquipment} รายการ`),
  ];
  if (issues.length) {
    contents.push({ type: 'separator', margin: 'md' });
    contents.push(flexText('อุปกรณ์ที่ต้องติดตาม', 'sm', 'bold', '#B42318'));
    for (const row of issues.slice(0, 5)) {
      contents.push(flexText(`${row[5]}: ${row[7]}${row[8] ? ` — ${row[8]}` : ''}`, 'sm', 'regular', '#B42318'));
    }
  }
  return {
    type: 'flex',
    altText: `สรุปยอดขายและตรวจงานประจำวันที่ ${date}`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents },
    },
  };
}

async function pushDailySummary(date) {
  if (!LINE_GROUP_ID) throw new Error('LINE_GROUP_ID is not configured');
  const message = await dailySummary(date);
  await lineRequest('message/push', { to: LINE_GROUP_ID, messages: [message] });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

  if (req.method === 'POST' && url.pathname === '/line/webhook') {
    let raw;
    try { raw = await readBody(req); } catch { return sendJson(res, 400, { ok: false }); }
    if (!verifySignature(raw, req.headers['x-line-signature'])) return sendJson(res, 401, { ok: false });
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { ok: false }); }
    if (!Array.isArray(body.events)) return sendJson(res, 400, { ok: false });
    if (body.events.length === 0) return sendJson(res, 200, { ok: true });
    try {
      for (const event of body.events) {
        const eventId = event.webhookEventId || event.message?.id || crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
        const ref = await reserveEvent(eventId);
        if (!ref) continue;
        try {
          await handleMessage(event, eventId);
          await ref.update({ status: 'done', updatedAt: Date.now() });
        } catch (error) {
          await ref.update({ status: 'failed', error: String(error.message || error).slice(0, 300), updatedAt: Date.now() });
          throw error;
        }
      }
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      console.error('Webhook processing failed', error);
      return sendJson(res, 500, { ok: false });
    }
  }

  if (req.method === 'POST' && url.pathname === '/admin/daily-summary') {
    if (req.headers.authorization !== `Bearer ${JOB_TOKEN}`) return sendJson(res, 401, { ok: false });
    try {
      const date = url.searchParams.get('date') || dateInZone();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { ok: false, error: 'date must be YYYY-MM-DD' });
      await pushDailySummary(date);
      return sendJson(res, 200, { ok: true, date });
    } catch (error) {
      console.error('Daily summary failed', error);
      return sendJson(res, 500, { ok: false });
    }
  }

  return sendJson(res, 404, { ok: false });
});

server.listen(PORT, '0.0.0.0', () => console.log(`LINE daily reporter listening on ${PORT}`));
