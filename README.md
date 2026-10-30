<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GMAIL FARMER | Dashboard</title>
<style>
:root{color-scheme:dark;--bg:#07110d;--panel:#101f18;--line:#234332;--green:#b7ff4a;--muted:#9db3a5}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 50% 0,#173d27 0,#07110d 48%);font-family:Arial,sans-serif;color:#f4fff7;min-height:100vh;display:grid;place-items:center;padding:22px}
main{width:min(100%,480px)}.card{background:#101f18ee;border:1px solid var(--line);border-radius:22px;padding:24px;box-shadow:0 18px 60px #0008}
.logo{width:104px;height:104px;object-fit:contain;display:block;margin:0 auto 12px;border-radius:20px}h1{text-align:center;font-size:22px;margin:8px 0 5px;letter-spacing:1px}.sub{text-align:center;color:var(--muted);font-size:13px;margin:0 0 22px}
.status{display:flex;align-items:center;gap:9px;padding:12px;border:1px solid var(--line);border-radius:12px;background:#0a1710;margin-bottom:20px;font-size:14px}.dot{width:9px;height:9px;border-radius:50%;background:#eab308;box-shadow:0 0 12px currentColor}
label{display:block;font-size:13px;color:#c9dfd0;margin:14px 0 7px}input{width:100%;padding:14px;border-radius:11px;border:1px solid #31523e;background:#08140d;color:white;font-size:16px;outline:none}input:focus{border-color:var(--green)}
button{width:100%;border:0;border-radius:12px;padding:15px;margin-top:17px;background:var(--green);color:#14200b;font-size:16px;font-weight:800;cursor:pointer}button:disabled{opacity:.55;cursor:wait}
.code{display:none;margin-top:18px;padding:18px;border:1px dashed var(--green);border-radius:14px;text-align:center;background:#172719}.code small{display:block;color:#c5d8ca;margin-bottom:9px}.code strong{font-size:28px;letter-spacing:3px;color:var(--green);word-break:break-word}
.note{font-size:12px;line-height:1.55;color:var(--muted);margin:18px 0 0}.error{color:#ff9d9d;font-size:13px;margin-top:12px;white-space:pre-wrap}
</style>
</head>
<body>
<main><section class="card">
<img class="logo" src="https://files.catbox.moe/eic9dy.png" alt="Gmail Farmer logo">
<h1>GMAIL FARMER</h1><p class="sub">WHATSAPP BOT CONTROL PANEL</p>
<div class="status"><span class="dot" id="dot"></span><span id="status">Checking server…</span></div>
<label for="phone">WhatsApp number (with country code)</label>
<input id="phone" inputmode="numeric" placeholder="947XXXXXXXX" autocomplete="tel">
<label for="token">Dashboard access token</label>
<input id="token" type="password" placeholder="Enter your PAIR_TOKEN">
<button id="connect">Generate Pairing Code</button>
<div class="code" id="codebox"><small>Enter this code in WhatsApp → Linked Devices → Link a Device → Link with phone number</small><strong id="paircode"></strong></div>
<div class="error" id="error"></div>
<p class="note">Keep your access token private. Never share your WhatsApp verification code or linked-device credentials. This dashboard uses Pairing Code only; it does not generate a QR code.</p>
</section></main>
<script>
const $=id=>document.getElementById(id);
async function check(){try{const r=await fetch('/');if(!r.ok)throw Error();$('status').textContent='Server is online';$('dot').style.background='#8cff55'}catch{$('status').textContent='Server is not reachable';$('dot').style.background='#ff5757'}}
$('connect').addEventListener('click',async()=>{
 const phone=$('phone').value.replace(/\D/g,'');const token=$('token').value.trim();
 $('error').textContent='';$('codebox').style.display='none';
 if(!/^[1-9]\d{7,14}$/.test(phone)){$('error').textContent='Enter a valid number with country code, e.g. 947XXXXXXXX.';return}
 if(!token){$('error').textContent='Enter the dashboard access token.';return}
 const b=$('connect');b.disabled=true;b.textContent='Requesting code…';
 try{const url='/pair?phone='+encodeURIComponent(phone)+'&token='+encodeURIComponent(token);const r=await fetch(url);const data=await r.json();if(!r.ok||!data.ok)throw Error(data.error||'Could not generate pairing code');if(data.connected){$('error').textContent='This WhatsApp session is already connected.'}else{$('paircode').textContent=data.code;$('codebox').style.display='block'}}
 catch(e){$('error').textContent=e.message}
 finally{b.disabled=false;b.textContent='Generate Pairing Code'}
});
check();
</script>
</body></html>
