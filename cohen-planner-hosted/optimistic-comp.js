'use strict';
const {scenarioKey}=require('./audited-comp-scenarios');
const {migrateP}=require('./public/plan-migrate');
const {nominalNormComp}=require('./public/model');
const kind=row=>!row.params?._archived&&scenarioKey(row.name);
function attach(rows) {
  const base=rows.find(row=>kind(row)==='base');
  if(!base)return rows;
  const cashSource=migrateP({...base.params,normManualThroughYear:2037});
  const baseStart=Number(cashSource.planStartYear||2026);
  const cashAt=yr=>nominalNormComp(cashSource,Math.max(0,yr-baseStart)).cash;
  return rows.map(row=>{
    if(kind(row)!=='optimistic')return row;
    const p=migrateP({...row.params,normManualThroughYear:2037});
    const start=Number(p.planStartYear||2026);
    const params={...p,optimisticVestShare:.5,optimisticStockActualThrough:2026,
      stripeSimplified:true,normGrowth:cashSource.normGrowth??.01,
      stripeManualLater:{...p.stripeManualLater},stripeGrants:{...p.stripeGrants,enabled:false}};
    for(let i=0;i<11;i++)params['normCashY'+i]=cashAt(start+i);
    for(let y=start+11;y<=2037;y++){
      params.stripeManualLater[y]={cash:cashAt(y),stock:nominalNormComp(p,y-start).stock};
    }
    return {...row,params,results:null};
  });
}
module.exports={attach};
