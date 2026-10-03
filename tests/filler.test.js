const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function content() {
  const context = vm.createContext({ console, setTimeout, clearTimeout, Uint8Array });
  const source = fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8').replace(/init\(\);\s*$/, '');
  vm.runInContext(source, context);
  return context;
}

test('no applicant identity or sensitive answers are supplied by default', () => {
  const c = content();
  assert.equal(c.canonicalEmail(), '');
  assert.equal(c.authorizationAnswer(), null);
  assert.equal(c.sponsorshipKnockoutAnswer(), null);
  assert.equal(c.relocationAnswer(), null);
  assert.equal(c.transgenderAnswer(), null);
  assert.equal(JSON.stringify(c.eeoAnswers()), '{}');
  assert.equal(c.shouldSkipVoluntaryField('Gender', 'gender'), true);
  vm.runInContext(`ctx={field_values:{email:'applicant@example.test'},static_answers:{authorized_to_work:false,requires_sponsorship:false}}`, c);
  assert.equal(c.canonicalEmail(), 'applicant@example.test');
  assert.equal(c.authorizationAnswer(), 'No');
  assert.equal(c.sponsorshipKnockoutAnswer(), 'No');
});

test('voluntary EEO requires opt-in; Hispanic questions are not mistaken for race', () => {
  const c = content();
  vm.runInContext(`ctx={static_answers:{fill_voluntary_eeo:true,gender:'Prefer not to say'}}`, c);
  assert.equal(c.eeoAnswers().gender, 'Prefer not to say');
  assert.equal(c.eeoAnswers().race, null);
  assert.equal(c.isRaceField('hispanic_ethnicity','Are you Hispanic/Latino?'), false);
  assert.equal(c.isRaceField('race','Race / Ethnicity'), true);
});

test('a prepared package cannot match a different job', () => {
  const c = content();
  const job = {platform:'greenhouse',boardToken:'example',jobId:'123'};
  const packageData = {platform:'greenhouse',board_token:'example',job_id:'123',application_id:1};
  assert.equal(c.contextMatchesJob(packageData, job), true);
  assert.equal(c.contextMatchesJob({...packageData,job_id:'456'},job), false);
  assert.equal(c.contextMatchesJob(packageData,{...job,jobId:null}), false);
});

test('synthetic webpage clicks cannot start filling, attach a file or submit', () => {
  const c = content();
  let handler, fill = 0, attach = 0, submit = 0;
  c.document = {addEventListener: (_event, fn) => {handler = fn;}};
  c.runAutoApplyFlow = async () => {fill++;};
  c.uploadUserResume = async () => {attach++;};
  c.submitNow = () => {submit++;};
  c.installPanelActions();
  for (const id of ['jobkit-fill','jobkit-attach-resume','jobkit-submit-now']) {
    handler({isTrusted:false,target:{closest:()=>({id})}});
  }
  assert.deepEqual([fill,attach,submit],[0,0,0]);
});

test('standalone resume attachment uses the user file with no prepared package', async () => {
  const c = content();
  let attached;
  c.safeSendMessage = async message => {
    assert.equal(message.type,'FETCH_USER_RESUME');
    return {resume:{bytes:Array.from(Buffer.from('%PDF-1.7\nSynthetic\n')),filename:'user-chosen.pdf'}};
  };
  c.File = class {constructor(parts,name,options){this.parts=parts;this.name=name;this.type=options.type;}};
  c.attachResumeFile = file => {attached=file;return true;};
  assert.equal(await c.uploadUserResume(),true);
  assert.equal(attached.name,'user-chosen.pdf');
  assert.equal(attached.type,'application/pdf');
  assert.equal(await c.uploadResumeFromPackage(),true);
});

test('unknown sponsorship does not erase a manually entered explanation', async () => {
  const c = content();
  c.document = {querySelector:()=>{throw Error('Must not clear fields without an explicit No');}};
  assert.equal(await c.fixSponsorshipFollowupField(),false);
  const fields=[{name:'sponsor_detail',label:'If you do require sponsorship',value:'User supplied'}];
  assert.equal(c.sanitizeCapturedFields(fields),fields);
});

test('password, hidden and CAPTCHA controls cannot receive text fills', () => {
  const c = content();
  c.isVisible=()=>true;
  for (const type of ['password','hidden','file']) assert.equal(c.safeSetValue({tagName:'INPUT',type},'value'),false);
  assert.equal(c.safeSetValue({tagName:'INPUT',type:'text',id:'g-recaptcha-response'},'value'),false);
  assert.equal(c.scoreSelectOption('Female',['Male']),-1);
});

test('automatic fills are not learned as manual corrections', async () => {
  const c = content(), sent=[];
  vm.runInContext(`userStarted=true;ctx={application_id:1}`,c);
  c.parseJobFromUrl=()=>({url:'https://job-boards.greenhouse.io/example/jobs/123',platform:'greenhouse',boardToken:'example',jobId:'123'});
  c.scrapeFormFields=()=>[{name:'answer',value:'User correction'}];
  c.sanitizeCapturedFields=fields=>fields;
  c.scrapeFormQuestions=()=>[{name:'answer',question:'Example question'}];
  c.safeSendMessage=async message=>{sent.push(message.payload);return {};};
  await c.sendCapture(false);
  assert.equal(sent[0].fields.length,0);
  vm.runInContext('userEditedSinceCapture=true',c);
  await c.sendCapture(false);
  assert.equal(sent[1].fields[0].value,'User correction');
});

test('similar why-company questions never reuse another company essay', () => {
  const c = content();
  vm.runInContext(`ctx={company:'Northstar'}`,c);
  const learned={'why do you want to join seabright?':'I want to join Seabright.','field:question_1':'I want to join Seabright.'};
  assert.equal(c.matchLearnedAnswer('question_1','Why do you want to join Northstar?',learned),null);
});

test('resume targeting prefers resume input over cover letter, including hidden inputs', () => {
  const c=content();
  const cover={id:'cover_letter',name:'',label:'Cover Letter'};
  const resume={id:'resume',name:'',label:'Resume/CV'};
  c.document={querySelectorAll:()=>[cover,resume]};
  c.fieldLabel=el=>el.label;
  assert.equal(c.findResumeFileInput(),resume);
  c.document.querySelectorAll=()=>[cover];
  assert.equal(c.findResumeFileInput(),undefined);
});
