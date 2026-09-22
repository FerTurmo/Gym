/* GymPro Super Matrix Engine
 * Version: 1.0.0
 * Purpose: convert profile + goal + roadmap phase + schedule + equipment + history
 * into a coach-like weekly resistance-training prescription.
 *
 * Integration target:
 *   const plan = GP_SUPER_MATRIX.plan(profile, {
 *     phaseIndex: S.phaseState?.index || 0,
 *     history: S.workoutHistory || [],
 *     exercises: EX || [],
 *     rules: EX_RULES || {}
 *   });
 *
 * The engine is deliberately pure: it does not read/write localStorage and does not
 * mutate GymPro state. That makes it safe to integrate into the existing single-file app.
 */
(function(global){
  'use strict';

  const VERSION='1.1.0';

  const MUSCLES=['chest','back','shoulders','arms','legs','glutes','calves','core'];
  const COMPONENTS={
    chest:['chest'],
    back:['back'],
    shoulders:['shoulders'],
    arms:['arms'],
    legs:['legs'],
    glutes:['glutes'],
    calves:['calves'],
    core:['core']
  };

  const GOAL={
    muscle:{volume:1.05,intensity:'moderate',repBias:'hypertrophy',freqBias:1.0},
    bodybuilder:{volume:1.18,intensity:'moderate',repBias:'hypertrophy',freqBias:1.05},
    recomp:{volume:1.00,intensity:'moderate',repBias:'hypertrophy',freqBias:1.0},
    fat:{volume:.78,intensity:'moderate',repBias:'mixed',freqBias:.9},
    strength:{volume:.82,intensity:'high',repBias:'strength',freqBias:1.0},
    athletic:{volume:.82,intensity:'moderate',repBias:'athletic',freqBias:.95},
    sport:{volume:.72,intensity:'moderate',repBias:'sport',freqBias:.8},
    health:{volume:.68,intensity:'moderate',repBias:'health',freqBias:.85}
  };

  const PHASE=[
    {name:'Foundation',volume:.72,effort:3,repShift:2,compoundSets:2,isolationSets:2},
    {name:'Accumulation',volume:.88,effort:2,repShift:1,compoundSets:3,isolationSets:2},
    {name:'Development',volume:1.00,effort:1,repShift:0,compoundSets:3,isolationSets:3},
    {name:'Consolidation',volume:.72,effort:3,repShift:2,compoundSets:2,isolationSets:2}
  ];

  const PHYSIQUE={
    very_thin:{volume:.78,lowerBody:.95,recovery:.90},
    thin:{volume:.88,lowerBody:.98,recovery:.95},
    normal:{volume:1,lowerBody:1,recovery:1},
    some_fat:{volume:.96,lowerBody:.98,recovery:.95},
    fat:{volume:.84,lowerBody:.92,recovery:.88},
    muscular:{volume:1.04,lowerBody:1.02,recovery:1.02},
    very_muscular:{volume:1.10,lowerBody:1.04,recovery:1.05}
  };

  const EXPERIENCE={
    beginner:{volume:.68,setsCap:2,rpe:7,recovery:1.08,frequencyCap:3},
    intermediate:{volume:.92,setsCap:3,rpe:8,recovery:1.0,frequencyCap:6},
    advanced:{volume:1.04,setsCap:4,rpe:8.5,recovery:.95,frequencyCap:7}
  };

  const DURATION_CAP={30:12,45:17,60:21,75:26,90:30};
  const DURATION_TARGET_EXERCISES={30:5,45:6,60:7,75:8,90:9};

  // Evidence-informed starting ranges. These are not hard physiological limits.
  // ACSM 2026 highlights training all major muscle groups at least twice weekly when
  // practical and using higher weekly volume for hypertrophy.
  const BASE_VOLUME={
    chest:[6,10,14],
    back:[8,12,16],
    shoulders:[5,8,12],
    arms:[4,7,10],
    legs:[6,10,14],
    glutes:[4,8,12],
    calves:[4,8,12],
    core:[3,6,9]
  };

  const REP={
    strength:{compound:[4,6],isolation:[8,10]},
    hypertrophy:{compound:[6,8],isolation:[10,12]},
    mixed:{compound:[8,10],isolation:[12,15]},
    athletic:{compound:[5,8],isolation:[8,12]},
    sport:{compound:[5,8],isolation:[8,12]},
    health:{compound:[8,12],isolation:[10,15]}
  };

  function n(v,d){ const x=Number(v); return Number.isFinite(x)?x:d; }
  function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
  function uniq(a){ return [...new Set((a||[]).filter(Boolean))]; }
  function arr(v){ return Array.isArray(v)?v:[]; }

  function normalizeProfile(p){
    p=p||{};
    const goal=GOAL[p.goal]?p.goal:'muscle';
    const exp=EXPERIENCE[p.experience]?p.experience:'beginner';
    const physique=PHYSIQUE[p.physique]?p.physique:'normal';
    const days=clamp(Math.round(n(p.daysPerWeek,p.minDays||3)),1,7);
    const duration=clamp(Math.round(n(p.duration,60)),30,90);
    const phase=clamp(Math.round(n(p.phaseIndex,0)),0,PHASE.length-1);
    return {
      age:clamp(n(p.age,30),13,100),
      sex:p.sex||'unknown',
      height:n(p.height,0),
      weight:n(p.weight,0),
      fat:n(p.fat,0),
      physique,
      experience:exp,
      goal,
      sport:p.sport||null,
      daysPerWeek:days,
      duration,
      equipment:uniq(p.equipment),
      priority:uniq(p.priority).slice(0,2),
      style:p.style||'balanced',
      split:p.split||'auto',
      protectedAreas:uniq(p.protectedAreas||p.limits),
      phaseIndex:phase
    };
  }

  function fatigueScore(history){
    const h=arr(history);
    if(!h.length)return 0;
    const recent=h.slice(-4);
    let missed=0,low=0,complete=0;
    recent.forEach(w=>{
      const sets=arr(w.exercises).flatMap(e=>arr(e.sets));
      if(!sets.length)return;
      const valid=sets.filter(s=>Number.isFinite(Number(s.reps)));
      const avg=valid.length?valid.reduce((a,s)=>a+Number(s.reps),0)/valid.length:0;
      if(valid.length>=sets.length*.8)complete++;
      if(avg>0 && avg<5)low++;
    });
    const adherence=recent.length?complete/recent.length:1;
    return clamp((1-adherence)*.6+low*.08,0,1);
  }

  function recoveryModifier(profile,history){
    const p=normalizeProfile(profile);
    const phys=PHYSIQUE[p.physique];
    const exp=EXPERIENCE[p.experience];
    const fatigue=fatigueScore(history);
    return clamp(phys.recovery*exp.recovery*(1-fatigue*.28),.65,1.12);
  }

  function musclePriority(profile,m){
    const p=normalizeProfile(profile);
    let x=1;
    if(p.priority.includes(m))x*=1.18;
    if(p.style==='aesthetic' && ['chest','shoulders','arms','glutes'].includes(m))x*=1.08;
    if(p.style==='performance' && ['legs','back','core','glutes'].includes(m))x*=1.08;
    if(p.goal==='sport'){
      const sport=p.sport;
      if(['football','running','cycling','triathlon','outdoor'].includes(sport) && ['legs','glutes','calves','core'].includes(m))x*=1.08;
      if(['basketball','rugby','tennis','padel','combat'].includes(sport) && ['legs','back','shoulders','core'].includes(m))x*=1.06;
    }
    return x;
  }

  function weeklyVolume(profile,history){
    const p=normalizeProfile(profile);
    const g=GOAL[p.goal]||GOAL.muscle;
    const ph=PHASE[p.phaseIndex];
    const ex=EXPERIENCE[p.experience];
    const phys=PHYSIQUE[p.physique];
    const recovery=recoveryModifier(p,history);
    const out={};
    MUSCLES.forEach(m=>{
      const b=BASE_VOLUME[m];
      let target=(b[1]*g.volume*ph.volume*ex.volume*phys.volume*recovery*musclePriority(p,m));
      if(m==='legs'||m==='glutes')target*=phys.lowerBody;
      if(p.daysPerWeek<3)target*=.82;
      if(p.daysPerWeek>=6)target*=.92;
      if(p.duration<=30)target*=.90;
      else if(p.duration<=45)target*=.98;
      else if(p.duration<=60)target*=1.05;
      else if(p.duration<=75)target*=1.12;
      else target*=1.18;
      if(protectedMuscles(p).has(m))target*=.72;
      const min=clamp(Math.round(b[0]*g.volume*.8),2,12);
      const max=clamp(Math.round(b[2]*Math.max(g.volume,1)),4,20);
      out[m]=clamp(Math.round(target),min,max);
    });
    return out;
  }

  function frequency(profile,muscle,volume){
    const p=normalizeProfile(profile);
    if(volume<=0)return 0;
    if(p.daysPerWeek<=2)return 1;
    if(volume>=10)return p.daysPerWeek>=4?2:1;
    if(volume>=6)return p.daysPerWeek>=5?2:1;
    return 1;
  }

  function distribute(total,freq){
    if(!freq)return [];
    if(freq===1)return [total];
    if(freq===2){
      const a=Math.ceil(total/2);
      return [a,total-a];
    }
    const base=Math.floor(total/freq),rem=total%freq;
    return Array.from({length:freq},(_,i)=>base+(i<rem?1:0)).filter(x=>x>0);
  }

  function splitFor(profile){
    const p=normalizeProfile(profile);
    if(p.split && p.split!=='auto')return p.split;
    if(p.daysPerWeek<=3)return 'fullbody';
    if(p.daysPerWeek===4)return 'upperlower';
    if(p.daysPerWeek>=5)return 'ppl';
    return 'fullbody';
  }

  function sessionBlueprint(profile){
    const p=normalizeProfile(profile),split=splitFor(p);
    if(split==='fullbody'){
      return Array.from({length:p.daysPerWeek},(_,i)=>({name:'Full body '+(i+1),groups:['legs','chest','back','shoulders','arms','core']}));
    }
    if(split==='upperlower'){
      const seq=['upper','lower'];
      return Array.from({length:p.daysPerWeek},(_,i)=>({
        name:seq[i%2]==='upper'?'Superior '+(Math.floor(i/2)+1):'Inferior '+(Math.floor(i/2)+1),
        groups:seq[i%2]==='upper'?['chest','back','shoulders','arms','core']:['legs','glutes','calves','core']
      }));
    }
    const seq=[['chest','shoulders','arms'],['back','arms','core'],['legs','glutes','calves','core']];
    return Array.from({length:p.daysPerWeek},(_,i)=>({name:['Push','Pull','Legs'][i%3]+' '+(Math.floor(i/3)+1),groups:seq[i%3]}));
  }

  const PROTECTED_MUSCLES={
    shoulder:['shoulders'],
    elbow:['arms'],
    wrist:['arms'],
    back:['back'],
    hip:['glutes','legs'],
    knee:['legs'],
    ankle:['legs','calves'],
    foot:['legs','calves']
  };
  function protectedMuscles(profile){
    const p=normalizeProfile(profile),out=new Set();
    p.protectedAreas.forEach(z=>{
      const key=String(z).toLowerCase();
      (PROTECTED_MUSCLES[key]||[]).forEach(m=>out.add(m));
    });
    return out;
  }
  function exerciseEquipment(ex){
    const e=String(ex?.eq||'').toLowerCase();
    return e;
  }

  function equipmentAllowed(profile,ex){
    const p=normalizeProfile(profile);
    if(!p.equipment.length)return true;
    return p.equipment.includes(exerciseEquipment(ex));
  }

  function exerciseUsage(history){
    const map={};
    arr(history).forEach(w=>arr(w.exercises).forEach(e=>{
      const id=e.exerciseId||e.exerciseName;
      if(!id)return;
      map[id]=(map[id]||0)+1;
    }));
    return map;
  }

  function chooseExercise(profile,muscle,history,exercises,rules,excludedIds){
    const p=normalizeProfile(profile);
    const excluded=new Set(arr(excludedIds));
    const list=arr(exercises).filter(e=>e && e.m===muscle && !excluded.has(e.id));
    if(!list.length)return null;
    const usage=exerciseUsage(history);
    const protectedArea=p.protectedAreas.map(z=>String(z).toLowerCase()).filter(Boolean),protectedMuscleSet=protectedMuscles(p);
    const candidates=list.map(e=>{
      const r=rules?.[e.id]||{};
      let score=100;
      if(!equipmentAllowed(p,e))score-=1000;
      if(protectedMuscleSet.has(muscle)||protectedArea.some(z=>String(e.name||'').toLowerCase().includes(z)))score-=200;
      if(usage[e.id])score-=usage[e.id]*7;
      if(p.goal==='strength' && r.kind==='compound')score+=18;
      if(['muscle','bodybuilder','recomp'].includes(p.goal) && r.kind==='compound')score+=8;
      if(p.goal==='athletic' && ['compound','stability'].includes(r.kind))score+=12;
      if(p.goal==='sport' && ['compound','stability'].includes(r.kind))score+=10;
      if(p.priority.includes(muscle))score+=15;
      return {e,score};
    }).sort((a,b)=>b.score-a.score);
    return candidates[0]?.e||null;
  }

  function repRange(profile,rule){
    const p=normalizeProfile(profile);
    const goal=(GOAL[p.goal]||GOAL.muscle).repBias;
    const kind=rule?.kind==='isolation'?'isolation':'compound';
    const r=(REP[goal]||REP.hypertrophy)[kind]||REP.hypertrophy[kind];
    const phaseShift=PHASE[p.phaseIndex].repShift;
    let lo=r[0]+phaseShift,hi=r[1]+phaseShift;
    if(p.goal==='strength' && kind==='compound'){lo=4;hi=6}
    if(p.goal==='bodybuilder' && kind==='isolation'){lo=Math.max(lo,10);hi=Math.max(hi,15)}
    if(p.goal==='fat'){lo+=1;hi+=1}
    return [lo,hi];
  }

  function setsFor(profile,rule,muscle,muscleShare,sessionMinutes){
    const p=normalizeProfile(profile),ph=PHASE[p.phaseIndex],exp=EXPERIENCE[p.experience];
    const kind=rule?.kind==='isolation'?'isolation':'compound';
    let sets=kind==='compound'?ph.compoundSets:ph.isolationSets;
    sets=Math.min(sets,exp.setsCap);
    if(muscleShare<=2)sets=Math.min(sets,2);
    if(sessionMinutes<=30)sets=Math.min(sets,2);
    if(p.goal==='strength' && kind==='compound')sets=Math.min(sets,3);
    if(p.goal==='health')sets=Math.min(sets,2);
    if(p.goal==='fat')sets=Math.max(2,sets-1);
    if(p.protectedAreas.includes(muscle)||p.protectedAreas.some(z=>String(muscle).includes(String(z))))sets=Math.max(1,sets-1);
    return clamp(Math.round(sets),1,4);
  }

  function exerciseMinutes(entry,rules){
    const r=rules?.[entry.exerciseId]||{};
    const kind=r.kind==='isolation'?'isolation':'compound';
    const perSet=kind==='isolation'?1.65:2.15;
    return 1.8+(entry.sets*perSet);
  }

  function sessionTime(scheduleItem,rules){
    return scheduleItem.exercises.reduce((sum,x)=>sum+exerciseMinutes(x,rules),0);
  }

  function targetExerciseCount(duration){
    const keys=Object.keys(DURATION_TARGET_EXERCISES).map(Number).sort((a,b)=>a-b);
    const d=clamp(Number(duration)||60,keys[0],keys[keys.length-1]);
    const exact=DURATION_TARGET_EXERCISES[d];
    if(exact)return exact;
    const lower=keys.filter(k=>k<=d).pop()||keys[0];
    const upper=keys.find(k=>k>d)||keys[keys.length-1];
    if(lower===upper)return DURATION_TARGET_EXERCISES[lower];
    const t=(d-lower)/(upper-lower);
    return Math.round(DURATION_TARGET_EXERCISES[lower]+t*(DURATION_TARGET_EXERCISES[upper]-DURATION_TARGET_EXERCISES[lower]));
  }

  function plan(profile,context){
    const p=normalizeProfile(profile);
    const history=arr(context?.history);
    const exercises=arr(context?.exercises);
    const rules=context?.rules||{};
    const volumes=weeklyVolume(p,history);
    const blueprint=sessionBlueprint(p);
    const schedule=blueprint.map((s,si)=>({index:si+1,name:s.name,groups:s.groups||[],exercises:[]}));

    MUSCLES.forEach(m=>{
      const freq=frequency(p,m,volumes[m]);
      const shares=distribute(volumes[m],freq);
      shares.forEach(share=>{
        const candidates=schedule
          .map((s,i)=>({s,i,load:s.exercises.reduce((a,x)=>a+x.sets,0),time:sessionTime(s,rules)}))
          .filter(x=>x.s.groups.includes(m) && !x.s.exercises.some(y=>y.muscle===m))
          .sort((a,b)=>a.time-b.time||a.load-b.load);
        const targetIndex=candidates.length?candidates[0].i:(
          schedule.map((s,i)=>({s,i,load:s.exercises.reduce((a,x)=>a+x.sets,0),time:sessionTime(s,rules)}))
            .filter(x=>x.s.groups.includes(m))
            .sort((a,b)=>a.time-b.time||a.load-b.load)[0]?.i
        );
        if(targetIndex===undefined)return;
        const ex=chooseExercise(p,m,history,exercises,rules,schedule[targetIndex].exercises.map(x=>x.exerciseId));
        if(!ex)return;
        const rule=rules[ex.id]||{};
        const reps=repRange(p,rule);
        const sets=setsFor(p,rule,m,share,p.duration);
        schedule[targetIndex].exercises.push({
          muscle:m,
          exerciseId:ex.id,
          exerciseName:ex.name,
          sets,
          reps,
          weeklyShare:share,
          frequency:freq,
          priority:p.priority.includes(m)
        });
      });
    });

    // Use the available time rather than treating duration as a fixed series cap.
    // First preserve the planned work, then add useful secondary exercises when
    // there is enough time and an unused exercise is available for that muscle.
    schedule.forEach(s=>{
      const targetCount=targetExerciseCount(p.duration);
      const cap=DURATION_CAP[p.duration]||21;
      let guard=0;

      while(
        s.exercises.length<targetCount &&
        sessionTime(s,rules)<p.duration-2 &&
        s.exercises.reduce((a,x)=>a+x.sets,0)<cap &&
        guard++<MUSCLES.length*3
      ){
        const candidates=s.groups
          .map(m=>{
            const existing=s.exercises.filter(x=>x.muscle===m);
            const currentSets=existing.reduce((a,x)=>a+x.sets,0);
            const target=volumes[m]||0;
            const need=Math.max(0,target-currentSets);
            return {m,need,priority:p.priority.includes(m),existing};
          })
          .filter(x=>x.need>0)
          .sort((a,b)=>Number(b.priority)-Number(a.priority)||b.need-a.need);

        let added=false;
        for(const candidate of candidates){
          const ex=chooseExercise(
            p,
            candidate.m,
            history,
            exercises,
            rules,
            s.exercises.map(x=>x.exerciseId)
          );
          if(!ex)continue;
          const rule=rules[ex.id]||{};
          const reps=repRange(p,rule);
          const sets=Math.min(
            setsFor(p,rule,candidate.m,Math.min(candidate.need,3),p.duration),
            candidate.need,
            cap-s.exercises.reduce((a,x)=>a+x.sets,0)
          );
          if(sets<1)continue;

          const item={
            muscle:candidate.m,
            exerciseId:ex.id,
            exerciseName:ex.name,
            sets,
            reps,
            weeklyShare:sets,
            frequency:frequency(p,candidate.m,volumes[candidate.m]),
            priority:p.priority.includes(candidate.m),
            secondary:true
          };
          const nextTime=sessionTime({exercises:[...s.exercises,item]},rules);
          if(nextTime>p.duration-1)continue;
          s.exercises.push(item);
          added=true;
          break;
        }
        if(!added)break;
      }

      // Final time/volume guard. Remove the least important work only if the
      // estimated session would exceed the user's available time.
      while(sessionTime(s,rules)>p.duration && s.exercises.length){
        const removable=s.exercises
          .map((x,i)=>({x,i}))
          .sort((a,b)=>{
            const pa=Number(a.x.priority)+Number(!a.x.secondary)*.25;
            const pb=Number(b.x.priority)+Number(!b.x.secondary)*.25;
            return pa-pb||b.x.sets-a.x.sets;
          })[0];
        if(removable.x.sets>1){
          removable.x.sets--;
        }else{
          s.exercises.splice(removable.i,1);
        }
      }
    });

    return {
      version:VERSION,
      profile:p,
      phase:PHASE[p.phaseIndex],
      weeklyVolume:volumes,
      split:splitFor(p),
      sessions:schedule,
      recoveryModifier:recoveryModifier(p,history),
      fatigueScore:fatigueScore(history)
    };
  }

  function progression(profile,exercise,loggedSets){
    const p=normalizeProfile(profile),sets=arr(loggedSets).filter(s=>Number.isFinite(Number(s.reps)));
    if(!sets.length)return {action:'start',weightChange:0,target:'upper_half'};
    const reps=sets.map(s=>Number(s.reps)),min=Math.min(...reps),max=Math.max(...reps);
    const rule={kind:exercise?.kind||'compound'};
    const [lo,hi]=repRange(p,rule);
    if(min<lo)return {action:'hold',weightChange:0,target:[lo,hi],reason:'minimum_reps_not_met'};
    if(reps.every(r=>r>=hi))return {action:'increase',weightChange:exercise?.eq==='machines'?5:2.5,target:[lo,hi],reason:'top_of_range'};
    if(max>=lo)return {action:'hold',weightChange:0,target:[Math.min(hi,max+1),hi],reason:'within_range'};
    return {action:'hold',weightChange:0,target:[lo,hi],reason:'below_target'};
  }

  function explain(plan){
    const p=plan.profile;
    return {
      decisionChain:[
        'Perfil físico + experiencia',
        'Objetivo principal',
        'Fase actual del roadmap',
        'Días y duración disponibles',
        'Equipamiento permitido',
        'Prioridades y zonas a proteger',
        'Volumen semanal por grupo muscular',
        'Frecuencia de estímulo',
        'Distribución por sesión',
        'Selección y rotación de ejercicios',
        'Series + rango de repeticiones',
        'Progresión según rendimiento real'
      ],
      summary:'El plan se recalcula a partir del contexto actual; no es una rutina fija.'
    };
  }

  function validate(plan){
    const errors=[];
    if(!plan||!Array.isArray(plan.sessions))errors.push('sessions');
    if(plan&&plan.sessions.some(s=>!Array.isArray(s.exercises)))errors.push('session_exercises');
    if(plan&&Object.values(plan.weeklyVolume||{}).some(v=>!Number.isFinite(v)||v<0))errors.push('weekly_volume');
    return {ok:errors.length===0,errors};
  }

  global.GP_SUPER_MATRIX={
    VERSION,
    muscles:MUSCLES.slice(),
    phases:PHASE.map(x=>({...x})),
    goals:Object.keys(GOAL),
    normalizeProfile,
    weeklyVolume,
    sessionBlueprint,
    chooseExercise,
    plan,
    progression,
    explain,
    validate
  };
})(window);
