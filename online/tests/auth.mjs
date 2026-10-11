import worker from '../src/worker.mjs';
for(const path of ['/','/app.js','/images/private.jpg','/api/session','/api/export','/api/rate','/api/audio/'+'a'.repeat(64)]){
 const r=await worker.fetch(new Request('https://private.example'+path),{ACCESS_TEAM:'',ACCESS_AUD:''},{});
 if(r.status!==503)throw Error('Anonymous request was not denied: '+path);
}
for(const path of ['/','/api/session','/api/export']){
 const r=await worker.fetch(new Request('https://private.example'+path,{headers:{'Cf-Access-Jwt-Assertion':'fake.fake.fake'}}),{ACCESS_TEAM:'example',ACCESS_AUD:'test',OWNER_EMAIL:'owner@example.com'},{});
 if(r.status!==401)throw Error('Forged token was not denied');
}
console.log('Authentication passed: unset identity denies all private routes (503); forged tokens denied (401). D1 and ASSETS never reached.');
