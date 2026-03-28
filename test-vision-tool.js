#!/usr/bin/env node

/**
 * Test script to verify vision model can see images in tool results.
 * This simulates what generate_and_review does but in isolation.
 */

import { streamChat } from './server/src/services/agent.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const IMAGES_DIR = join(homedir(), '.quje-agent', 'images');

async function testVisionWithImage() {
  console.log('=== Vision Model Test ===\n');
  
  // Configuration
  const modelId = process.argv[2] || 'qwen3.5:latest';
  const imageUuid = process.argv[3];
  
  if (!imageUuid) {
    console.log('Usage: node test-vision-tool.js [model] [image-uuid]');
    console.log('\nExample: node test-vision-tool.js qwen3.5:latest abc123-def456');
    console.log('\nTo find recent image UUIDs:');
    console.log('  ls -lt ~/.quje-agent/images/ | head');
    process.exit(1);
  }
  
  console.log(`Model: ${modelId}`);
  console.log(`Image UUID: ${imageUuid}\n`);
  
  // Load image
  const imagePath = join(IMAGES_DIR, imageUuid, 'image.jxl');
  let imageBuffer;
  let mimeType = 'image/jxl';
  
  try {
    imageBuffer = await readFile(imagePath);
    console.log(`✓ Loaded image: ${imagePath}`);
    console.log(`  Size: ${(imageBuffer.length / 1024).toFixed(1)} KB\n`);
  } catch {
    // Try thumbnail
    const thumbPath = join(IMAGES_DIR, imageUuid, 'thumb.webp');
    try {
      imageBuffer = await readFile(thumbPath);
      mimeType = 'image/webp';
      console.log(`✓ Loaded thumbnail: ${thumbPath}`);
      console.log(`  Size: ${(imageBuffer.length / 1024).toFixed(1)} KB\n`);
    } catch (err) {
      console.error(`✗ Failed to load image or thumbnail for ${imageUuid}`);
      console.error(`  Tried: ${imagePath}`);
      console.error(`  Tried: ${thumbPath}`);
      process.exit(1);
    }
  }
  
  // Build test message with image
  const testMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'Look at this image carefully. Describe what you see in detail, including:\n1. The main subject\n2. The setting/background\n3. The mood/atmosphere\n4. Any text visible\n5. The color palette\n\nBe specific and honest about what\'s actually in the image.'
      },
      {
        type: 'image',
        data: imageBuffer.toString('base64'),
        mimeType: mimeType
      }
    ],
    timestamp: Date.now()
  };
  
  console.log('Sending image to model...\n');
  console.log('--- Model Response ---\n');
  
  try {
    const result = await streamChat(
      modelId,
      [testMessage],
      'You are a helpful assistant that analyzes images. Describe what you see accurately and in detail.',
      (event) => {
        if (event.type === 'text_delta') {
          process.stdout.write(event.delta);
        } else if (event.type === 'thinking_delta') {
          // Optionally show thinking
        } else if (event.type === 'done') {
          console.log('\n');
        } else if (event.type === 'error') {
          console.error('\n[ERROR]', event.error?.errorMessage || 'Unknown error');
        }
      }
    );
    
    console.log('\n--- Test Complete ---');
    console.log(`Tokens used: ${result.usage?.totalTokens || 'unknown'}`);
    console.log(`Stop reason: ${result.stopReason}`);
    
    if (result.stopReason === 'error') {
      console.error('\n✗ Model encountered an error');
      process.exit(1);
    } else if (result.content.length < 50) {
      console.warn('\n⚠ Model response was very short - might not have seen the image');
    } else {
      console.log('\n✓ Model successfully processed the image!');
    }
    
  } catch (err) {
    console.error('\n✗ Test failed:', err.message);
    process.exit(1);
  }
}

testVisionWithImage().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
