#!/usr/bin/env node
/**
 * Integration test: Feishu streaming card preview
 * Tests: create card → patch 3 times → delete
 *
 * Usage: node scripts/test-feishu-streaming.mjs [chat_id]
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

// ── Load config ──
const configPath = resolve(homedir(), '.claude-to-im', 'config.env');
const configText = readFileSync(configPath, 'utf-8');
const config = {};
for (const line of configText.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq < 0) continue;
  config[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
}

const appId = config.CTI_FEISHU_APP_ID;
const appSecret = config.CTI_FEISHU_APP_SECRET;
const chatId = process.argv[2] || 'oc_7b6bc3669ade30bddce0c68eb9ab2891';

if (!appId || !appSecret) {
  console.error('Missing CTI_FEISHU_APP_ID or CTI_FEISHU_APP_SECRET in config.env');
  process.exit(1);
}

console.log(`Testing streaming card in chat: ${chatId}`);
console.log(`App ID: ${appId}`);

const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  // Step 1: Create initial card with update_multi: true
  console.log('\n[1/5] Creating initial card...');
  const cardJson = JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    body: {
      elements: [
        { tag: 'markdown', content: '⏳ 正在思考...\n\n`▍`' },
      ],
    },
  });

  const createRes = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: cardJson,
    },
  });

  if (!createRes?.data?.message_id) {
    console.error('❌ Card create failed:', createRes?.msg, createRes?.code);
    process.exit(1);
  }

  const messageId = createRes.data.message_id;
  console.log(`✅ Card created: ${messageId}`);

  // Step 2-4: Patch with progressive content
  const steps = [
    '这是一个**流式输出**的测试。\n\n`▍`',
    '这是一个**流式输出**的测试。\n\n飞书卡片会像打字一样逐步更新内容，就像 ChatGPT 的效果。\n\n`▍`',
    '这是一个**流式输出**的测试。\n\n飞书卡片会像打字一样逐步更新内容，就像 ChatGPT 的效果。\n\n```python\ndef hello():\n    print("Hello from streaming!")\n```\n\n✅ 流式输出测试完成！',
  ];

  for (let i = 0; i < steps.length; i++) {
    await sleep(800); // Simulate typing delay
    console.log(`\n[${i + 2}/5] Patching card (step ${i + 1}/${steps.length})...`);

    const patchCardJson = JSON.stringify({
      schema: '2.0',
      config: { wide_screen_mode: true, update_multi: true },
      body: {
        elements: [
          { tag: 'markdown', content: steps[i] },
        ],
      },
    });

    try {
      await client.im.message.patch({
        path: { message_id: messageId },
        data: { content: patchCardJson },
      });
      console.log(`✅ Patch ${i + 1} succeeded`);
    } catch (err) {
      console.error(`❌ Patch ${i + 1} failed:`, err.message || err);
    }
  }

  // Step 5: Delete the preview card (simulating endPreview)
  await sleep(2000);
  console.log('\n[5/5] Deleting preview card...');
  try {
    await client.im.message.delete({
      path: { message_id: messageId },
    });
    console.log('✅ Card deleted');
  } catch (err) {
    console.error('❌ Delete failed:', err.message || err);
    console.log('(This is expected if bot lacks im:message permission)');
  }

  console.log('\n🎉 Streaming card test complete!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
