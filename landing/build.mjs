import {mkdir,copyFile,readFile,writeFile,cp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
await mkdir('dist',{recursive:true});
execFileSync(process.execPath,['node_modules/tailwindcss/lib/cli.js','-i','src/styles.css','-o','dist/styles.css','--content','src/page.html','--minify'],{stdio:'inherit'});
await cp('assets','dist/assets',{recursive:true});
const page=await readFile('src/page.html','utf8');
await writeFile('dist/index.html','<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Form</title><meta name="description" content="Receive messages from your website in your inbox. Host Open Form on your own Cloudflare account and connect Resend."><link rel="stylesheet" href="styles.css"></head><body>'+page+'</body></html>');
