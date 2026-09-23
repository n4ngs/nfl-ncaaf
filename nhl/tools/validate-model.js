#!/usr/bin/env node
'use strict';
// Offline only: no provider sockets or network. Input must be an authorized, provenance-bearing dataset.
const fs=require('node:fs'),path=require('node:path');
const {validate}=require('../lib/model');
function run(input,output){
 const bundle=JSON.parse(fs.readFileSync(input,'utf8'));
 const result=validate(bundle);
 fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'nhl-model-validation.json'),JSON.stringify(result.report,null,2)+'\n');
 // Never leave a formerly passing artifact beside a now failing report.
 const target=path.join(output,'nhl-model.json');
 if(result.artifact)fs.writeFileSync(target,JSON.stringify(result.artifact,null,2)+'\n');else if(fs.existsSync(target))fs.unlinkSync(target);
 return result.report;
}
if(require.main===module){const [input,output]=process.argv.slice(2);if(!input||!output){console.error('Usage: node nhl/tools/validate-model.js <authorized-inputs.json> <output-directory>');process.exitCode=2;}else{try{const r=run(input,output);console.log(JSON.stringify({status:r.status,sourceRows:r.sourceRows,eligible:r.eligible,counts:r.counts,metrics:r.metrics},null,2));}catch(e){console.error('Validation failed: '+e.message);process.exitCode=1;}}}
module.exports={run};
