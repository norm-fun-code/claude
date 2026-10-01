 'use strict';
// Eastern calendar and display rules shared by the browser and server.
// Date-only ledger values are calendar dates, not midnight UTC timestamps.
(function(root){
  const zone='America/New_York';
  const dayPattern=/^\d{4}-\d{2}-\d{2}$/;
  function date(value=new Date()){
    return new Date(typeof value==='string'&&dayPattern.test(value)?value+'T12:00:00Z':value);
  }
  function day(value=new Date()){
    if(typeof value==='string'&&dayPattern.test(value))return value;
    const d=date(value);
    if(!Number.isFinite(d.getTime()))return '';
    const p=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
    const get=k=>p.find(x=>x.type===k).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  function year(value){return Number(day(value).slice(0,4));}
  function month(value){return Number(day(value).slice(5,7))-1;}
  function formatDate(value,options={month:'short',day:'numeric',year:'numeric'}){
    return date(value).toLocaleDateString('en-US',{...options,timeZone:zone});
  }
  function formatTime(value,options={month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}){
    return date(value).toLocaleString('en-US',{...options,timeZone:zone,timeZoneName:'short'});
  }
  const api={zone,date,day,year,month,formatDate,formatTime};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerTime=api;
})(typeof globalThis!=='undefined'?globalThis:this);
