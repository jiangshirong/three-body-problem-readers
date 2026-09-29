import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawFile = path.join(project, 'outputs', 'us-pronunciations.json');
const canonicalFile = path.join(project, 'outputs', 'us-pronunciations-v2.json');
const readerFile = path.join(project, 'outputs', 'three-body-reader.html');
const reportFile = path.join(project, 'outputs', '美式音标逐词核验报告.md');
const cambridge = word => `https://dictionary.cambridge.org/us/pronunciation/english/${word}`;
const cambridgePronunciation = word => `https://dictionary.cambridge.org/pronunciation/english/${word}`;
const verified = [
  {word:'an', sourceIpa:'US strong /æn/; weak /ən/', readerIpa:'/æn/ · /ən/', status:'Cambridge US 明列强读与弱读；模型初筛漏掉强弱读排序，已按来源顺序更正'},
  {word:'abnormal', sourceIpa:'US /æbˈnɔːr.məl/', readerIpa:'/æbˈnɔːrməl/', status:'DeepSeek 报疑点；Cambridge US 确认现有候选，未采纳 Wiktionary 的额外候选'},
  {word:'absolute', sourceIpa:'/ˈæb.sə.luːt/', readerIpa:'/ˈæbsəluːt/', status:'DeepSeek 标出本地重音差异；按 Cambridge US 补入词典主读音，原候选保留'},
  {word:'absolutely', sourceIpa:'/ˌæb.səˈluːt.li/', readerIpa:'/ˌæbsəˈluːtli/', status:'DeepSeek 报疑点；Cambridge US 核验现有主读音'},
  {word:'absorption', sourceIpa:'/əbˈzɔːrp.ʃən/; US Dictionary /əbˈzɔrp·ʃən, æb-, -ˈsɔrp-/', readerIpa:'/əbˈzɔːrpʃən/ · /əbˈsɔːrpʃən/ · /æbˈzɔːrpʃən/', status:'Cambridge US Dictionary 明列 æb- 与 s 音变体，补入有来源支持的 /æb/ 起始读音'},
  {word:'aesthetic', sourceIpa:'US /esˈθet̬.ɪk/', readerIpa:'/esˈθetɪk/', status:'DeepSeek 报符号差异；Cambridge US 核验现有读音，项目记法省略闪音符号'},
  {word:'prediction', sourceIpa:'/prɪˈdɪk.ʃən/', readerIpa:'/prɪˈdɪkʃən/', status:'核验一致；原有 CMUdict 转写已按 Cambridge 美式音标修正'},
  {word:'celestial', sourceIpa:'/sɪˈles.tʃ ə l/', readerIpa:'/sɪˈlestʃəl/', oldIpa:'/səˈlestʃəl/', status:'已更正首音节元音；原记录无可追溯词典来源'},
  {word:'tinged', sourceIpa:'/tɪndʒd/', readerIpa:'/tɪndʒd/', status:'核验一致'},
  {word:'rehydration', sourceIpa:'/ˌriː.haɪˈdreɪ.ʃ ə n/', readerIpa:'/ˌriːhaɪˈdreɪʃən/', status:'核验一致；仅移除音节分隔点与版面空格'},
  {word:'Copenhagen', sourceIpa:'/ˌkoʊ.p ə nˈheɪ.ɡ ə n/', readerIpa:'/ˌkoʊpənˈheɪɡən/', oldIpa:'/ˈkoʊpənˌheɪɡən/', status:'已更正主重音与次重音位置；元音和辅音不变'},
  {word:'Europe', sourceIpa:'/ˈjʊr.əp/', readerIpa:'/ˈjʊrəp/', status:'常见美式读音核验一致；作为排序首选'},
  {word:'Paris', sourceIpa:'/ˈper.ɪs/', readerIpa:'/ˈperɪs/', status:'Cambridge US 美式读音核验一致；作为排序首选，保留已标地域变体'},
  {word:'Africa', sourceIpa:'/ˈæf.rɪ.kə/', readerIpa:'/ˈæfrɪkə/', status:'Cambridge US 常见读音核验一致；其它 CMUdict 变体另列待核'},
  {word:'Gregory', sourceIpa:'/ˈɡreɡ.ə r.i/', readerIpa:'/ˈɡreɡ(ə)ri/', status:'核验一致；可选轻音与音节分隔规范化'},
  {word:'Han', sourceIpa:'/hæn/; /hɑːn/', readerIpa:'/hɑːn/; /hæn/', status:'Cambridge US 明确列出两种形式，均保留'},
  {word:'Hugo', sourceIpa:'/ˈhjuː.ɡoʊ/', readerIpa:'/ˈhjuːɡoʊ/', status:'常见读音核验一致；Wiktionary 标注的较少见形式保留次位'},
  {word:'Israel', sourceIpa:'/ˈɪz.reɪl/; NAmE /ˈɪzriəl/', readerIpa:'/ˈɪzriəl/ · /ˈɪzreɪl/', sourceUrl:'https://www.oxfordlearnersdictionaries.com/us/definition/american_english/israel', sourceLabel:'Oxford NAmE + Collins US; Cambridge variant', status:'Oxford 与 Collins 均列 /ɪzriəl/；Cambridge 另列 /ɪzreɪl/。两种均有美式来源，将双重词典支持的 /ɪzriəl/ 置前，保留另一读音'},
  {word:'Mongolia', sourceIpa:'/mɑːŋˈɡoʊ.li.ə/', readerIpa:'/mɑːŋˈɡoʊliə/', status:'常见美式读音核验一致；缩约变体另列待核'},
  {word:'Mozart', sourceIpa:'/ˈmoʊt.sɑːrt/', readerIpa:'/ˈmoʊtsɑːrt/', status:'Cambridge US 常见读音核验一致；/z/ 变体另列待核'},
  {word:'Rome', sourceIpa:'/roʊm/', readerIpa:'/roʊm/', status:'Cambridge US 读音核验一致并为首选；相同 Wiktionary 候选的口音标签待查'},
  {word:'Russian', sourceIpa:'/ˈrʌʃ.ən/', readerIpa:'/ˈrʌʃən/', status:'Cambridge US 主读音一致；本地带可选轻音的写法暂保留，未当作已证实的独立常用读音'},
  {word:'Watson', sourceIpa:'/ˈwɑːt.sən/', readerIpa:'/ˈwɑːtsən/', status:'Cambridge US 主读音一致；带可选轻音的同形转写暂保留'},
  {word:'side', sourceIpa:'/saɪd/', readerIpa:'/saɪd/', status:'书中普通名词/动词读音一致；另有来源标为专名的 /ˈsiːdeɪ/，不按普通词候选删除'},
  {word:'Euler', sourceIpa:'/ˈɔɪlər/; Cambridge US also lists /ˈjuːlɚ/', readerIpa:'/ˈɔɪlər/ · /ˈjuːlər/', status:'两种候选都有来源；美式数学教育来源普遍使用 Oiler，维持其首位，保留 Cambridge 的 YOO-ler 形式'},
  {word:'Jupiter', sourceIpa:'/ˈdʒuː.pə.t̬ɚ/', readerIpa:'/ˈdʒuːpətər/', status:'Cambridge US 弱读 /ə/ 并标出闪音；将本地已有 /ə/ 候选提为首选，保留 /ɪ/ 候选'},
  {word:'project', sourceIpa:'noun /ˈprɑː.dʒekt/; verb /prəˈdʒekt/', readerIpa:'noun /ˈprɑːdʒekt/; verb /prəˈdʒekt/', addedPronunciation:true, status:'补入来源明确的美式名词读音；动词读音原已存在，未删除其他候选'},
  {word:'record', sourceIpa:'noun /ˈrek.ɚd/; verb /rɪˈkɔːrd/', readerIpa:'noun /ˈrekərd/; verb /rɪˈkɔːrd/', status:'核验一致；名词与动词读音不同，原数据已有对应词性标签'},
  {word:'research', sourceIpa:'US /ˈriː.sɝːtʃ/, /rɪˈsɝːtʃ/', readerIpa:'/ˈriːsɜːrtʃ/ · /rɪˈsɜːrtʃ/', status:'Cambridge US 两种重音均收录；名词、动词都可用两种读法，不强行添加词性标签'},
  {word:'use', sourceIpa:'noun /juːs/; verb /juːz/', readerIpa:'noun /juːs/; verb /juːz/', status:'核验一致；名词与动词读音及原数据词性标签对应正确'},
  {word:'tori', sourceIpa:'/ˈtɔːr.aɪ/', readerIpa:'/ˈtɔːraɪ/', sourceUrl:cambridgePronunciation('tori'), status:'正文数学语境为 torus 的复数；补入 Cambridge US 明确列出的读音，旧同形词候选保留待审'},
  {word:'again', sourceIpa:'/əˈɡen/', readerIpa:'/əˈɡen/ · /əˈɡeɪn/', status:'Cambridge US 确认 /əˈɡen/；作为首选。另一形式见 Cambridge Academic 内容，故保留'},
  {word:'human', sourceIpa:'/ˈhjuː.mən/', readerIpa:'/ˈhjuːmən/ · /ˈjuːmən/', status:'Cambridge US 确认带 /h/ 的读音；无 /h/ 候选不据单一词典遗漏删除，列待核'},
  {word:'because', sourceIpa:'conjunction /bɪˈkʌz/; US also /bɪˈkɑːz/', readerIpa:'/bɪˈkʌz/ · /bɪˈkɑːz/ · /bɪˈkɔːz/ · /bɪkəz/', status:'Cambridge US 确认 /ʌ/、/ɑː/ 两种；将 conjunction 主式置前，/ɔː/ 与弱读项待独立核验'},
  {word:'within', sourceIpa:'/wɪˈðɪn/', readerIpa:'/wɪˈðɪn/ · /wɪˈθɪn/', status:'Cambridge US 确认 /ð/；另一 General-American 候选保留待独立核验'},
  {word:'either', sourceIpa:'/ˈiː.ðɚ/; /ˈaɪ.ðɚ/', readerIpa:'/ˈiːðər/ · /ˈaɪðər/', status:'Cambridge US 明确列出两种读音；均保留，以词典列序作为首选'},
  {word:'often', sourceIpa:'/ˈɑːf.ən/; /ˈɑːf.tən/', readerIpa:'/ˈɑːfən/ · /ˈɑːftən/ · /ˈɔːfən/ · /ˈɔːftən/', status:'Cambridge US 的两种 /ɑː/ 形式此前缺失，已补入；保留已有 /ɔː/ 候选待查'},
  {word:'route', sourceIpa:'/ruːt/; /raʊt/', readerIpa:'/ruːt/ · /raʊt/', status:'Cambridge US 明确列出两种读音；均保留，原有顺序与词典列序一致'},
  {word:'process', sourceIpa:'noun /ˈprɑː.ses/; verb /ˈprɑː.ses/, /prəˈses/', readerIpa:'/ˈprɑːses/ · /ˈproʊses/ · /prəˈses/', status:'Cambridge US 核实 /ɑː/ 及动词次重音形式；/oʊ/ 候选尚未由本轮来源裁定，保留待核'},
  {word:'what', sourceIpa:'/wɑːt/', readerIpa:'/wɑːt/ · /wʌt/', status:'Cambridge US 确认 /wɑːt/；本地另有 /wʌt/，留待独立美式来源裁定'},
  {word:'been', sourceIpa:'/bɪn/; /ben/', readerIpa:'/bɪn/ · /bɛn/ · /bən/', status:'Cambridge US 确认 /bɪn/ 与 /ben/；补入第二种并保留弱读候选待核'},
  {word:'with', sourceIpa:'/wɪð/', readerIpa:'/wɪð/ · /wɪθ/', status:'Cambridge US 确认 /wɪð/；Wiktionary 的 /wɪθ/ 变体保留待独立核验'},
  {word:'all', sourceIpa:'/ɑːl/', readerIpa:'/ɑːl/ · /ɔːl/', status:'Cambridge US 确认 /ɑːl/ 并提为首选；本地 /ɔːl/ 有 General-American 标签，暂不删除'},
  {word:'before', sourceIpa:'/bɪˈfɔːr/; Academic US also /bɪˈfoʊr/', readerIpa:'/bɪˈfɔːr/ · /bɪˈfoʊr/ · /bəˈfɔːr/ · /biˈfɔːr/', status:'Cambridge US 确认 /bɪˈfɔːr/ 和 Academic 变体；补入 /foʊr/ 项，其余弱读变体待核'},
  {word:'woman', sourceIpa:'/ˈwʊm.ən/', readerIpa:'/ˈwʊmən/ · /ˈwoʊmən/', status:'Cambridge US 确认 /ˈwʊmən/；/woʊ/ 变体保留待核'},
  {word:'data', sourceIpa:'/ˈdeɪ.t̬ə/; /ˈdæt̬.ə/', readerIpa:'/ˈdeɪtə/ · /ˈdætə/', status:'Cambridge US 明确列出两种读音；数据已有，来源核验一致'},
  {word:'fire', sourceIpa:'/faɪr/', readerIpa:'/faɪr/ · /ˈfaɪər/', status:'Cambridge US 确认单音节 /faɪr/ 并提为首选；双音节形式保留待核'},
  {word:'during', sourceIpa:'/ˈdʊr.ɪŋ/', readerIpa:'/ˈdʊrɪŋ/ · /ˈdɜːrɪŋ/ · /ˈdjʊrɪŋ/', status:'Cambridge US 确认 /ˈdʊrɪŋ/；其他两种本地候选留待核'},
  {word:'between', sourceIpa:'/bɪˈtwiːn/', readerIpa:'/bɪˈtwiːn/ · /bəˈtwiːn/ · /biˈtwiːn/', status:'Cambridge US 确认 /bɪˈtwiːn/；其余弱读候选留待核'},
  {word:'want', sourceIpa:'/wɑːnt/; Cambridge Academic US also /wɔnt/', readerIpa:'/wɑːnt/ · /wɔːnt/', status:'两种读音均有 Cambridge 美式来源；主词典列式置前，保留另一口音变体'},
  {word:'really', sourceIpa:'/ˈriː.ə.li/; Academic US also /ˈriː.li/', readerIpa:'/ˈriːəli/ · /ˈriːli/', status:'Cambridge US 与 Academic US 均列本地已有读音；核验一致'},
  {word:'also', sourceIpa:'Advanced US /ˈɑːl.soʊ/; Academic US /ˈɔl.soʊ/', readerIpa:'/ˈɑːlsoʊ/ · /ˈɔːlsoʊ/', status:'Cambridge 两种美式词典体系分别列出两者；均保留，主词典 /ɑː/ 形式置前'},
  {word:'already', sourceIpa:'Advanced US /ɑːlˈred.i/; Academic US /ɔlˈred.i/', readerIpa:'/ɑːlˈredi/ · /ɔːlˈredi/ · /ɔːˈredi/', status:'两种 Cambridge 美式词典体系均有来源；补入 Advanced US 形式，保留两者；无 /l/ 候选待核'},
  {word:'asked', sourceIpa:'US /æskt/; North American informal reduction /æst/', readerIpa:'/æskt/ · /æst/', sourceUrl:'https://www.oxfordlearnersdictionaries.com/definition/english/ask_1', sourceLabel:'Oxford American + Wiktionary General American', status:'Oxford US 明确列 /æskt/；Wiktionary 标注的 /æst/ 省音变体保留待判断是否展示'},
  {word:'against', sourceIpa:'/əˈɡenst/', readerIpa:'/əˈɡenst/ · /əˈɡeɪnst/', status:'Cambridge US 确认 /əˈɡenst/；本地 /eɪ/ 候选留待独立美式来源确认'},
  {word:'your', sourceIpa:'strong /jʊr/; weak /jɚ/; Academic US also /jɔr/', readerIpa:'/jʊr/ · /jɔːr/ · /jər/ · /jɜːr/ · /jɪr/', status:'Cambridge Advanced US 确认强读与弱读，Academic US 另列 /jɔr/；置强读形式于首，地域变体留存'},
  {word:'their', sourceIpa:'/ðer/', readerIpa:'/ðer/ · /ðər/', status:'Cambridge US 确认 /ðer/；本地弱读形式保留待核'},
  {word:'them', sourceIpa:'pronoun strong /ðem/, weak /ðəm/; determiner /ðem/', readerIpa:'/ðem/ · /ðəm/', status:'Cambridge US 同时明确列出代词强读、弱读及限定词读音；核验一致'},
  {word:'when', sourceIpa:'US /wen/; Academic US also /hwɛn/', readerIpa:'/wen/ · /hwen/', status:'Cambridge US 确认 /wen/；Academic US 收录保留 /hw/ 的 /hwɛn/ 变体；保留并以主读音列首'},
  {word:'to', sourceIpa:'US strong /tuː/; weak /tə/, /t̬ə/, /tu/', readerIpa:'/tuː/ · /tə/ · /t̬ə/ · /tu/', status:'补入两种 Cambridge US 弱读；剔除仅标 UK 的 /tʊ/，将 /toʊ/ 同形读音限定为大写专名 To'},
  {word:'that', sourceIpa:'strong /ðæt/; weak /ðət/', readerIpa:'/ðæt/ · /ðət/', status:'Cambridge US 对不同词性分别标出强读与弱读；现有两式核验一致'},
  {word:'and', sourceIpa:'strong /ænd/; weak /ənd/, /ən/', readerIpa:'/ænd/ · /ənd/ · /ən/', status:'补入 Cambridge US 明列的弱读 /ən/；原有强读和 /ənd/ 弱读核验一致'},
  {word:'a', sourceIpa:'weak /ə/; strong /eɪ/', readerIpa:'/ə/ · /eɪ/', status:'Cambridge US 确认不定冠词的弱读和强调强读；两式均保留'},
  {word:'for', sourceIpa:'strong /fɔːr/; weak /fɚ/', readerIpa:'/fɔːr/ · /fər/', status:'Cambridge US 明确列出强读与弱读；保留两式并规范为项目使用的 IPA 字形'},
  {word:'on', sourceIpa:'US /ɑːn/; US variant /ɔn/', readerIpa:'/ɑːn/ · /ɔːn/', sourceUrls:[cambridge('on'),'https://www.collinsdictionary.com/us/dictionary/english/on'], sourceLabels:['Cambridge US','Collins American English'], status:'Cambridge US 列 /ɑːn/；Collins American English 同列 /ɑn, ɔn/。保留两个美式变体，按词典主列顺序排列'},
  {word:'her', sourceIpa:'strong /hɝː/; weak /hɚ/, /ɚ/', readerIpa:'/hɜːr/ · /hər/ · /ər/', status:'Cambridge US 明确列出强读和两种弱读；保留三式并规范为项目使用的 IPA 字形'},
  {word:'in', sourceIpa:'/ɪn/', readerIpa:'/ɪn/', status:'Cambridge US 单词发音页确认 /ɪn/；核验一致'},
  {word:'of', sourceIpa:'weak /əv/; strong /ʌv/, /ɑːv/', readerIpa:'/əv/ · /ʌv/ · /ɑːv/', sourceUrls:[cambridge('of'),'https://www.collinsdictionary.com/us/dictionary/english/of'], sourceLabels:['Cambridge US','Collins American English'], status:'Cambridge US 确认弱读 /əv/ 与强读 /ɑːv/；Collins US 另确认强读 /ʌv/。按常用弱读优先，保留两种强读'},
  {word:'the', sourceIpa:'weak /ðə/; strong /ðiː/', readerIpa:'/ðə/ · /ði/ · /ðiː/', status:'Cambridge US 确认 /ðə/ 与 /ðiː/；另有 /ði/ 候选用于元音前弱读，缺少本轮所查来源的明确标注，保留并列入待核'},
  {word:'you', sourceIpa:'strong /juː/; weak /ju/, /jə/; variant /jʊ/', readerIpa:'/juː/ · /ju/ · /jə/ · /jʊ/', sourceUrls:[cambridge('you'),'https://dictionary.cambridge.org/us/dictionary/learner-english/you'], sourceLabels:['Cambridge US','Cambridge Learner’s US'], status:'Cambridge US 与 Learner’s Dictionary 列出强读及弱读；保留 Cambridge 所列 /jʊ/ 变体，新增缺失候选并按强弱形式排列'},
  {word:'we', sourceIpa:'strong /wiː/; weak /wi/', readerIpa:'/wiː/ · /wi/', status:'Cambridge US 明确列出强读与弱读；补入原词库漏掉的弱读 /wi/'},
  {word:'it', sourceIpa:'/ɪt/; Intermediate US also /ət/', readerIpa:'/ɪt/ · /ət/', sourceUrls:[cambridge('it'),'https://dictionary.cambridge.org/us/dictionary/english/it'], sourceLabels:['Cambridge US pronunciation','Cambridge Intermediate US'], status:'Cambridge US 常规发音为 /ɪt/；Cambridge Intermediate US 另列 /ət/，补入弱读形式'},
  {word:'from', sourceIpa:'strong /frʌm/; weak /frəm/; US variant /frɑm/', readerIpa:'/frʌm/ · /frəm/ · /frɑm/', sourceUrls:[cambridge('from'),'https://dictionary.cambridge.org/us/dictionary/english/from'], sourceLabels:['Cambridge US pronunciation','Cambridge US Intermediate'], status:'补入词库漏掉的弱读 /frəm/ 与美式变体 /frɑm/；三种均由 Cambridge US 词典列出'},
  {word:'at', sourceIpa:'strong /æt/; weak /ət/', readerIpa:'/æt/ · /ət/', status:'Cambridge US 明确列出强读与弱读；补入词库漏掉的弱读 /ət/'},
  {word:'as', sourceIpa:'strong /æz/; weak /əz/', readerIpa:'/æz/ · /əz/', status:'Cambridge US 明确列出强读与弱读；现有两式核验一致'},
  {word:'by', sourceIpa:'/baɪ/', readerIpa:'/baɪ/', status:'Cambridge US 单词发音页确认 /baɪ/；核验一致'},
  {word:'have', sourceIpa:'strong /hæv/; weak /həv/, /əv/, /v/', readerIpa:'/hæv/ · /həv/ · /əv/ · /v/', sourceUrls:[cambridge('have'),'https://dictionary.cambridge.org/us/dictionary/english/have'], sourceLabels:['Cambridge US pronunciation','Cambridge US Intermediate'], status:'补入本地漏掉的三种弱读，均见 Cambridge US 词典；保持强读在前、弱读随后'},
  {word:'has', sourceIpa:'strong /hæz/; weak /həz/, /əz/', readerIpa:'/hæz/ · /həz/ · /əz/', status:'Cambridge US 明列强读及两种弱读；补入本地漏掉的 /əz/'},
  {word:'was', sourceIpa:'US /wɑːz/; Intermediate /wʌz/, /wɑz/, /wəz/', readerIpa:'/wɑːz/ · /wəz/ · /wʌz/', sourceUrls:[cambridge('was'),'https://dictionary.cambridge.org/us/dictionary/english/was'], sourceLabels:['Cambridge US pronunciation','Cambridge US Intermediate'], status:'保留现有美式主读与弱读，补入 Cambridge US Intermediate 列出的 /wʌz/；另列的 /wɑz/ 与项目现有 /wɑːz/ 为长度标记规范差异'},
  {word:'were', sourceIpa:'US strong /wɝː/; weak /wɚ/', readerIpa:'/wɜːr/ · /wər/', sourceUrls:[cambridge('were'),'https://dictionary.cambridge.org/pronunciation/english/were'], sourceLabels:['Cambridge US dictionary','Cambridge US pronunciation'], status:'补入 Cambridge US 收录的弱读 /wɚ/，按项目 IPA 习惯规范为 /wər/'},
  {word:'do', sourceIpa:'US verb /də/, /du/, /duː/; noun note /doʊ/', readerIpa:'/də/ · /du/ · 动 /duː/ · 名 /doʊ/', sourceUrls:[cambridge('do'),'https://dictionary.cambridge.org/us/dictionary/english/do'], sourceLabels:['Cambridge US pronunciation','Cambridge US dictionary'], status:'补入动词及助动词漏掉的 /də/、/du/；为动词与名词的异读保留词性标签，/doʊ/ 仅对应音名 do'},
  {word:'does', sourceIpa:'verb strong /dʌz/, weak /dəz/; noun plural of doe /doʊz/', readerIpa:'/dʌz/ · /dəz/ · 名 /doʊz/', sourceUrls:[cambridge('does'),'https://dictionary.cambridge.org/us/dictionary/english/doe','https://www.dictionary.com/browse/doe?q=DOE','https://en.wiktionary.org/wiki/does#English'], sourceLabels:['Cambridge US verb','Cambridge US doe entry','Dictionary.com US doe entry','Wiktionary US homograph'], status:'补入动词弱读 /dəz/；保留 /doʊz/，它是 doe 的复数而非 do 的动词形式，已用美式读音来源核验'},
  {word:'did', sourceIpa:'/dɪd/', readerIpa:'/dɪd/', status:'Cambridge US 单词发音页确认 /dɪd/；未发现有来源支持的独立常见弱读，核验一致'},
  {word:'can', sourceIpa:'strong /kæn/; weak /kən/', readerIpa:'/kæn/ · /kən/', sourceUrls:['https://dictionary.cambridge.org/us/dictionary/english/can','https://dictionary.cambridge.org/us/pronunciation/english/can'], sourceLabels:['Cambridge US Dictionary','Cambridge US pronunciation'], status:'Cambridge US 明确列出情态动词 can 的强读 /kæn/ 与弱读 /kən/；补入原词库缺失的弱读'},
  {word:'could', sourceIpa:'strong /kʊd/; weak /kəd/', readerIpa:'/kʊd/ · /kəd/', sourceUrls:['https://dictionary.cambridge.org/us/dictionary/english/could','https://dictionary.cambridge.org/us/pronunciation/english/could'], sourceLabels:['Cambridge US Dictionary','Cambridge US pronunciation'], status:'Cambridge US 明确列出强读 /kʊd/ 与弱读 /kəd/；补入原词库缺失的弱读'},
  {word:'must', sourceIpa:'strong /mʌst/; weak /məst/, /məs/', readerIpa:'/mʌst/ · /məst/ · /məs/', sourceUrls:['https://dictionary.cambridge.org/us/dictionary/english/must','https://dictionary.cambridge.org/us/pronunciation/english/must'], sourceLabels:['Cambridge US Dictionary','Cambridge US pronunciation'], status:'Cambridge US 明确列出强读 /mʌst/ 与弱读 /məst/、/məs/；补入原词库缺失的两种弱读'},
  {word:'will', sourceIpa:'US strong /wɪl/; weak /wəl/', readerIpa:'/wɪl/ · /wəl/', sourceUrls:['https://dictionary.cambridge.org/us/dictionary/english/will','https://dictionary.cambridge.org/us/dictionary/learner-english/will'], sourceLabels:['Cambridge US Dictionary','Cambridge Learner’s US'], status:'Cambridge US 常规词条收强读 /wɪl/，Learner’s US 列 /wɪl, wəl/；补入弱读 /wəl/，不把单独的缩约形式 ll 混作本词 IPA'},
  {word:'would', sourceIpa:'US strong /wʊd/; weak /wəd/', readerIpa:'/wʊd/ · /wəd/', sourceUrls:['https://dictionary.cambridge.org/us/dictionary/english/would','https://dictionary.cambridge.org/us/dictionary/learner-english/would'], sourceLabels:['Cambridge US Dictionary','Cambridge Learner’s US'], status:'Cambridge US 明列强读 /wʊd/ 与弱读 /wəd/；UK-only 的 /əd/ 不加入美式记录'},
  {word:'should', sourceIpa:'US strong /ʃʊd/; weak /ʃəd/', readerIpa:'/ʃʊd/ · /ʃəd/', sourceUrls:['https://dictionary.cambridge.org/us/dictionary/english/should','https://dictionary.cambridge.org/us/pronunciation/english/should'], sourceLabels:['Cambridge US Dictionary','Cambridge US pronunciation'], status:'Cambridge US 明列强读 /ʃʊd/ 与弱读 /ʃəd/；补入本地词库缺失的弱读'},
  {word:'may', sourceIpa:'US /meɪ/', readerIpa:'/meɪ/', sourceUrl:'https://dictionary.cambridge.org/us/pronunciation/english/may', status:'Cambridge US 发音页确认 /meɪ/；未列独立弱读，本地读音核验一致'},
  {word:'might', sourceIpa:'US /maɪt/', readerIpa:'/maɪt/', sourceUrls:['https://dictionary.cambridge.org/pronunciation/american-english/might','https://www.collinsdictionary.com/us/dictionary/english/might'], sourceLabels:['Cambridge American pronunciation','Collins American English'], status:'Cambridge 与 Collins 美式发音均确认 /maɪt/；未列独立弱读，本地读音核验一致'},
  {word:'shall', sourceIpa:'US strong /ʃæl/; weak /ʃəl/', readerIpa:'/ʃæl/ · /ʃəl/', sourceUrls:['https://dictionary.cambridge.org/us/dictionary/english/shall','https://dictionary.cambridge.org/us/pronunciation/english/shall'], sourceLabels:['Cambridge US Dictionary','Cambridge US pronunciation'], status:'Cambridge US 明列强读 /ʃæl/ 与弱读 /ʃəl/；补入本地词库缺失的弱读'},
  {word:'be', sourceIpa:'US strong /biː/; weak /bi/, /bɪ/', readerIpa:'/biː/ · /bi/ · /bɪ/', sourceUrl:'https://dictionary.cambridge.org/us/pronunciation/english/be', status:'Cambridge US 明列强读 /biː/ 与弱读 /bi/、/bɪ/；补入 CMUdict 漏掉的 /bɪ/ 弱读，并确认已有 /bi/ 的强弱读身份'},
  {word:'had', sourceIpa:'US strong /hæd/; weak /həd/, /əd/', readerIpa:'/hæd/ · /həd/ · /əd/', sourceUrls:['https://dictionary.cambridge.org/us/pronunciation/english/had','https://dictionary.cambridge.org/us/dictionary/english/had'], sourceLabels:['Cambridge US pronunciation','Cambridge US Dictionary'], status:'Cambridge US 明列过去式 had 的强读 /hæd/ 与弱读 /həd/、/əd/；补入两种漏记弱读'},
  {word:'he', sourceIpa:'US strong /hiː/; weak /hi/, /i/', readerIpa:'/hiː/ · /hi/ · /i/', sourceUrl:'https://dictionary.cambridge.org/us/pronunciation/english/he', status:'Cambridge US 明列代词 he 的强读 /hiː/ 与弱读 /hi/、/i/；补入两种漏记弱读'},
  {word:'she', sourceIpa:'US strong /ʃiː/; weak /ʃi/', readerIpa:'/ʃiː/ · /ʃi/', sourceUrl:'https://dictionary.cambridge.org/us/pronunciation/english/she', status:'Cambridge US 明列强读 /ʃiː/ 与弱读 /ʃi/；补入本地词库漏记的弱读'},
  {word:'being', sourceIpa:'US /ˈbiː.ɪŋ/', readerIpa:'/ˈbiːɪŋ/', sourceUrl:'https://dictionary.cambridge.org/us/pronunciation/english/being', status:'Cambridge US 明列 /ˈbiː.ɪŋ/；阅读器仅移除音节点，核验一致'},
  {word:'doing', sourceIpa:'US /ˈduː.ɪŋ/', readerIpa:'/ˈduːɪŋ/', sourceUrl:'https://dictionary.cambridge.org/pronunciation/english/doing', status:'Cambridge US 明列 /ˈduː.ɪŋ/；阅读器仅移除音节点，核验一致'},
  {word:'say', sourceIpa:'US /seɪ/', readerIpa:'/seɪ/', sourceUrl:'https://www.oxfordlearnersdictionaries.com/us/definition/english/say_1', sourceLabel:'Oxford American', status:'Oxford American verb entry lists /seɪ/ for say; recorded IPA核验一致'},
  {word:'said', sourceIpa:'US /sed/', readerIpa:'/sed/', sourceUrl:'https://www.oxfordlearnersdictionaries.com/us/definition/english/say_1', sourceLabel:'Oxford American', status:'Oxford American verb forms list /sed/ for both past simple and past participle;核验一致'},
  {word:'saying', sourceIpa:'US /ˈseɪɪŋ/', readerIpa:'/ˈseɪɪŋ/', sourceUrls:['https://www.oxfordlearnersdictionaries.com/us/definition/english/say_1','https://www.oxfordlearnersdictionaries.com/us/definition/american_english/saying'], sourceLabels:['Oxford American verb forms','Oxford American noun entry'], status:'Oxford American 分别核验动词 -ing 形式与名词 saying；均为 /ˈseɪɪŋ/'},
  {word:'is', sourceIpa:'US strong /ɪz/; weak /əz/, /z/, /s/', readerIpa:'/ɪz/ · /əz/ · /z/ · /s/', sourceUrls:['https://dictionary.cambridge.org/pronunciation/english/is','https://dictionary.cambridge.org/us/dictionary/english/is'], sourceLabels:['Cambridge US pronunciation','Cambridge US Dictionary'], status:'Cambridge US 发音页明确列 /z/、/s/ 弱读；US Intermediate 另列 /əz/；补齐三种弱读'},
  {word:'are', sourceIpa:'US strong /ɑːr/; weak /ɚ/, /ər/, /r/', readerIpa:'/ɑːr/ · /ər/ · /r/', sourceUrls:['https://dictionary.cambridge.org/pronunciation/english/are','https://dictionary.cambridge.org/us/dictionary/english/are'], sourceLabels:['Cambridge US pronunciation','Cambridge US Dictionary'], status:'Cambridge US 明列强读 /ɑːr/、弱读 /ɚ/；US Intermediate 另列 /ər/、/r/；按项目美式 IPA 习惯将 /ɚ/ 记作 /ər/'}
];
const pendingReview = [
  {word:'Africa', candidates:['/ˈæfrɪkə/','/ˈæfərkə/','/ˈæfrəkɑː/'], evidence:'Cambridge US confirms /ˈæf.rɪ.kə/. CMUdict has two further vowel variants, not listed by Cambridge; a single dictionary omission is insufficient grounds to delete them.', sources:[cambridge('africa'),'https://github.com/cmusphinx/cmudict']},
  {word:'Mongolia', candidates:['/mɑːŋˈɡoʊliə/','/mɑːŋˈɡoʊljə/'], evidence:'Cambridge US confirms /mɑːŋˈɡoʊ.li.ə/. CMUdict also has a y-glide reduction; its status as a distinct common pronunciation is not established.', sources:[cambridge('mongolia'),'https://github.com/cmusphinx/cmudict']},
  {word:'Mozart', candidates:['/ˈmoʊtsɑːrt/','/ˈmoʊzɑːrt/'], evidence:'Cambridge US gives /ˈmoʊt.sɑːrt/; CMUdict also has /z/. Since the latter may be a familiarized variant or an error, do not remove it until independently verified.', sources:[cambridge('mozart'),'https://github.com/cmusphinx/cmudict']},
  {word:'Rome', candidates:['/roʊm/','/rəʊm/'], evidence:'Cambridge distinguishes UK /rəʊm/ from US /roʊm/, while the Wiktionary-derived /rəʊm/ record is tagged US. This may be a mismatched accent tag or a transcription-convention issue; flag it for resolution.', sources:[cambridge('rome'),'https://en.wiktionary.org/wiki/Rome#English']},
  {word:'tori', candidates:['/ˈtɔːraɪ/','/toriː/','/ˈtɔːri/'], evidence:'The book passage discusses tori alongside solid crosses and a Möbius strip, so the word is the mathematical plural of torus. Cambridge explicitly gives the US plural /ˈtɔːr.aɪ/; that missing reading has been added. Existing candidates may belong to the homographic name and remain pending, not deleted.', sources:[cambridgePronunciation('tori'),'https://dictionary.cambridge.org/us/dictionary/english/torus']},
  {word:'side', candidates:['/saɪd/','/ˈsiːdeɪ/'], evidence:'Cambridge US confirms /saɪd/ for the ordinary lexical item, and the novel uses side in its ordinary noun/verb senses. The second candidate is a Wiktionary General-American record tagged as a proper name; retain it as a homograph pending a name-specific source, not as a common-word variant.', sources:[cambridge('side'),'https://en.wiktionary.org/wiki/Side#English']},
  {word:'project', candidates:['/ˈprɑːˌdʒekt/','/ˈprɑːdʒɪkt/','/ˈprɑːdʒekt/'], evidence:'Cambridge US explicitly gives noun /ˈprɑː.dʒekt/ and verb /prəˈdʒekt/; the standard noun record has been added and the verb was already present. The two other local noun candidates are retained pending independent American evidence.', sources:[cambridge('project'),'https://en.wiktionary.org/wiki/project#English']},
  {word:'record', candidates:['/ˈrekərd/','/ˈrekɔːrd/','/rɪˈkɔːrd/'], evidence:'Cambridge US confirms noun /ˈrek.ɚd/ and verb /rɪˈkɔːrd/; the extra local noun /ˈrekɔːrd/ is not established by that source. Keep it pending an independent American dictionary source.', sources:[cambridge('record'),'https://en.wiktionary.org/wiki/record#English']},
  {word:"I'll", candidates:['/aɪl/','/ɑːl/'], evidence:'Cambridge lists US /aɪl/ and Academic Content /ɑɪl/; the Wiktionary US record contains /ɑːl/ and also tags UK. Because /ɑɪl/ and /ɑːl/ are not equivalent transcriptions, retain both pending a dialect-specific source that resolves the latter.', sources:[cambridge('i-ll'),'https://dictionary.cambridge.org/us/dictionary/english/i-ll','https://en.wiktionary.org/wiki/I%27ll#English']},
  {word:'human', candidates:['/ˈhjuːmən/','/ˈjuːmən/'], evidence:'Cambridge US lists /ˈhjuː.mən/; CMUdict also contains a no-/h/ candidate. The status and commonness of the latter need an independent US source; keep it for now.', sources:[cambridge('human'),'https://github.com/cmusphinx/cmudict']},
  {word:'because', candidates:['/bɪˈkʌz/','/bɪˈkɑːz/','/bɪˈkɔːz/','/bɪkəz/'], evidence:'Cambridge US explicitly lists /bɪˈkʌz/ and /bɪˈkɑːz/ for conjunction, and /bɪˈkɑːz/ for informal preposition. The local /ɔː/ and unstressed /kəz/ records need independent evidence before removal or promotion.', sources:[cambridge('because'),'https://github.com/cmusphinx/cmudict']},
  {word:'within', candidates:['/wɪˈðɪn/','/wɪˈθɪn/'], evidence:'Cambridge US lists /wɪˈðɪn/; Wiktionary tags /wɪˈθɪn/ General-American. Since the second is a conflicting source-listed candidate, retain pending independent confirmation.', sources:[cambridge('within'),'https://en.wiktionary.org/wiki/within#English']}
  ,{word:'process', candidates:['/ˈprɑːses/','/ˈproʊses/','/prəˈses/'], evidence:'Cambridge US gives /ˈprɑː.ses/ for noun and ordinary verb, and /prəˈses/ for the “walk” sense. The /oʊ/ form appears in local AI-derived data but is not resolved by this source; retain pending another US dictionary.', sources:[cambridge('process'),'https://en.wiktionary.org/wiki/process#English']}
  ,{word:'what', candidates:['/wɑːt/','/wʌt/'], evidence:'Cambridge US lists /wɑːt/. The local /wʌt/ is AI-derived and needs an independent General-American source before it is kept as a common variant or removed.', sources:[cambridge('what'),'https://en.wiktionary.org/wiki/what#English']}
  ,{word:'been', candidates:['/bɪn/','/bɛn/','/bən/'], evidence:'Cambridge US lists /bɪn/ and /ben/; the weak /bən/ candidate is present in CMUdict but not confirmed by the source checked here.', sources:[cambridge('been'),'https://github.com/cmusphinx/cmudict']}
  ,{word:'with', candidates:['/wɪð/','/wɪθ/'], evidence:'Cambridge US gives /wɪð/. Wiktionary tags /wɪθ/ General-American; keep it pending independent confirmation of its status as a distinct common citation form.', sources:[cambridge('with'),'https://en.wiktionary.org/wiki/with#English']}
  ,{word:'all', candidates:['/ɑːl/','/ɔːl/'], evidence:'Cambridge US lists /ɑːl/, while the Wiktionary General-American record includes /ɔl/ without a UK tag. Preserve both while checking the status of the /ɔ/ form in American varieties.', sources:[cambridge('all'),'https://en.wiktionary.org/wiki/all#English']}
  ,{word:'before', candidates:['/bɪˈfɔːr/','/bɪˈfoʊr/','/bəˈfɔːr/','/biˈfɔːr/'], evidence:'Cambridge US lists /bɪˈfɔːr/ and Cambridge Academic Content gives /bɪˈfoʊr/ as an alternate. The local reduced-vowel candidates need additional US evidence; keep pending.', sources:[cambridge('before'),'https://dictionary.cambridge.org/us/dictionary/english/before']}
  ,{word:'woman', candidates:['/ˈwʊmən/','/ˈwoʊmən/'], evidence:'Cambridge US lists /ˈwʊm.ən/. Wiktionary also tags /ˈwoʊmən/ General-American; retain pending an independent US source.', sources:[cambridge('woman'),'https://en.wiktionary.org/wiki/woman#English']}
  ,{word:'fire', candidates:['/faɪr/','/ˈfaɪər/'], evidence:'Cambridge US lists /faɪr/. Wiktionary has a two-syllable /ˈfaɪər/ candidate tagged General-American; hold it pending a US dictionary source before deciding whether it is a separate citation form.', sources:[cambridge('fire'),'https://en.wiktionary.org/wiki/fire#English']}
  ,{word:'during', candidates:['/ˈdʊrɪŋ/','/ˈdɜːrɪŋ/','/ˈdjʊrɪŋ/'], evidence:'Cambridge US lists /ˈdʊr.ɪŋ/. The additional CMUdict forms may reflect distinct accents, variants, or transcription distinctions; retain until independently classified.', sources:[cambridge('during'),'https://github.com/cmusphinx/cmudict']}
  ,{word:'between', candidates:['/bɪˈtwiːn/','/bəˈtwiːn/','/biˈtwiːn/'], evidence:'Cambridge US confirms /bɪˈtwiːn/. Wiktionary lists schwa and /i/ variants as General-American; hold those pending another US source.', sources:[cambridge('between'),'https://en.wiktionary.org/wiki/between#English']}
  ,{word:'asked', candidates:['/æskt/','/æst/'], evidence:'Oxford US lists /æskt/ as the past form; Wiktionary labels /æst/ General American as an alternate. Need to establish whether the latter is a broad, lexical citation form or only casual cluster reduction.', sources:['https://www.oxfordlearnersdictionaries.com/definition/english/ask_1','https://en.wiktionary.org/wiki/asked#English']}
  ,{word:'against', candidates:['/əˈɡenst/','/əˈɡeɪnst/'], evidence:'Cambridge US lists /əˈɡenst/; /əˈɡeɪnst/ appears in UK and CMU-derived local records. Keep it pending independent American evidence.', sources:[cambridge('against'),'https://github.com/cmusphinx/cmudict']}
  ,{word:'already', candidates:['/ɑːlˈredi/','/ɔːlˈredi/','/ɔːˈredi/'], evidence:'Cambridge Advanced US lists /ɑːlˈred.i/ while Cambridge Academic US uses /ɔlˈred.i/; the local no-/l/ form remains unexplained. Preserve all until a source clarifies its phonetic status.', sources:[cambridge('already'),'https://dictionary.cambridge.org/us/dictionary/english/already']}
  ,{word:'your', candidates:['/jʊr/','/jɔːr/','/jɜːr/','/jər/','/jɪr/'], evidence:'Cambridge Advanced US marks /jʊr/ as strong and /jɚ/ as weak; Academic US also lists /jɔr/ and /jər/. Northwestern /jɪr/ and the precise status of /jɜːr/ need a separate dialect-specific audit; retain them.', sources:[cambridge('your'),'https://dictionary.cambridge.org/us/dictionary/english/your']}
  ,{word:'their', candidates:['/ðer/','/ðər/'], evidence:'Cambridge US confirms /ðer/; the local schwa form may be a speech reduction rather than a dictionary citation variant. Keep pending a source that labels its status.', sources:[cambridge('their'),'https://en.wiktionary.org/wiki/their#English']}
  ,{word:'the', candidates:['/ðə/','/ði/','/ðiː/'], evidence:'Cambridge US explicitly lists weak /ðə/ and strong /ðiː/, but does not show the local /ði/ form. It is commonly described as the pre-vowel weak form, yet this pass does not have a directly checked US dictionary entry explicitly supporting that exact IPA. Keep it pending rather than treating the contextual realization as a separately verified citation pronunciation.', sources:[cambridge('the')]}
  ,{word:'says', candidates:['/sez/','/sɪz/'], evidence:'Cambridge US and Oxford American both list /sez/ for the verb form says. CMUdict contributes a second /sɪz/ candidate, for which no independent authoritative American dictionary evidence has been found in this pass; retain unresolved rather than silently deleting it.', sources:['https://dictionary.cambridge.org/us/pronunciation/english/says','https://www.oxfordlearnersdictionaries.com/us/definition/english/say_1','https://github.com/cmusphinx/cmudict']}
];

function updateCelestial(entries) {
  const record = entries?.celestial?.find(item => item.ipa === '/səˈlestʃəl/' || item.ipa === '/sɪˈlestʃəl/');
  if (!record) throw new Error('未找到待核验的 celestial 原记录，停止以避免误改。');
  Object.assign(record, {
    ipa:'/sɪˈlestʃəl/', pos:'', posLabel:'', accent:'General-American',
    tags:['General-American'], source:cambridge('celestial'), sources:[cambridge('celestial')],
    originalTags:['US'], origin:'source-audited', reviewVersion:'cambridge-us-2026-09-23',
    sourceRevision:'checked-2026-09-23', rawPronunciation:'/sɪˈles.tʃ ə l/',
    conversionVersion:'learner-us-1',
    calibrationNote:'Cambridge US: /sɪˈles.tʃ ə l/; syllable dots and display spacing normalized.'
  });
}

function updateCopenhagen(entries) {
  const records = entries?.copenhagen;
  if (!Array.isArray(records)) throw new Error('未找到 Copenhagen 词条，停止以避免误改。');
  const matches = records.filter(item => item.ipa === '/ˈkoʊpənˌheɪɡən/' || item.ipa === '/ˌkoʊpənˈheɪɡən/');
  if (!matches.length) throw new Error('未找到 Copenhagen 的 Cambridge 可核验候选。');
  for (const record of matches) {
    record.ipa = '/ˌkoʊpənˈheɪɡən/';
    record.auditPreviousIpa = '/ˈkoʊpənˌheɪɡən/';
    record.auditSources = [...new Set([...(record.auditSources || []), cambridge('copenhagen')])];
    record.reviewVersion = 'cambridge-us-2026-09-23';
    record.calibrationNote = 'Cambridge US places primary stress on heɪ and secondary stress on koʊ; syllable dots and spacing normalized.';
  }
}

function promote(entries, word, ipa, {sourceUrl=cambridge(word.toLowerCase()), reviewVersion='cambridge-us-2026-09-23', calibrationNote}={}) {
  const records = entries?.[word.toLowerCase()];
  if (!Array.isArray(records)) throw new Error(`未找到 ${word} 词条。`);
  const selected = records.filter(item => item.ipa === ipa).map(record=>({...record,
    auditSources:[...new Set([...(record.auditSources||[]),sourceUrl])],
    sourceAuditVersion:reviewVersion,
    calibrationNote:calibrationNote || `Cambridge US confirms ${ipa}; promoted as the default General American reading without deleting other source-listed variants.`
  }));
  if (!selected.length) throw new Error(`未找到 ${word} 的已核验首选 ${ipa}。`);
  const others = records.filter(item => item.ipa !== ipa);
  entries[word.toLowerCase()] = [...selected, ...others].map((record, index) => ({...record, rank:index+1}));
}

function ensureTori(entries) {
  const list = entries.tori ||= [];
  let record = list.find(item => item.ipa === '/ˈtɔːraɪ/' && item.origin === 'source-audited');
  if (!record) {
    record = {
      headword:'tori', ipa:'/ˈtɔːraɪ/', pos:'noun', posLabel:'名', accent:'General-American',
      tags:['US'], source:cambridgePronunciation('tori'), sources:[cambridgePronunciation('tori')],
      supportingSources:['https://dictionary.cambridge.org/us/dictionary/english/torus'], originalTags:['US'],
      origin:'source-audited', reviewVersion:'cambridge-us-2026-09-23', sourceRevision:'checked-2026-09-23',
      rawPronunciation:'/ˈtɔːr.aɪ/', conversionVersion:'learner-us-1',
      calibrationNote:'Cambridge US lists the mathematical plural tori as /ˈtɔːr.aɪ/.'
    };
  }
  entries.tori = [record, ...list.filter(item => item !== record)].map((item, index) => ({...item, rank:index+1}));
}

function annotateEuler(entries) {
  const list=entries.euler;
  if (!Array.isArray(list)) throw new Error('未找到 Euler 词条，停止以避免误改。');
  for (const record of list) {
    record.auditSources=[...new Set([...(record.auditSources||[]),
      'https://dictionary.cambridge.org/us/pronunciation/english/euler',
      'https://www.ahdictionary.com/word/search.html?q=Euler',
      'https://www.dictionary.com/browse/euler',
      'https://mechse.illinois.edu/news/blogs/euler-appreciation'])];
    record.reviewVersion='multi-source-us-2026-09-23';
    record.calibrationNote=record.ipa==='/ˈɔɪlər/'
      ? 'American Heritage and Dictionary.com give Oiler; mathematics sources corroborate this as the common specialist form. Cambridge also lists /ˈjuːlɚ/; retain that sourced variant second.'
      : 'Cambridge US lists /ˈjuːlɚ/; retained as a sourced alternate, not promoted over the common mathematics-context Oiler form.';
  }
  const grouped=new Map();
  for(const record of list){const group=grouped.get(record.ipa)||[];group.push(record);grouped.set(record.ipa,group);}
  const order=['/ˈɔɪlər/','/ˈjuːlər/'];
  const ordered=[...order.flatMap(ipa=>grouped.get(ipa)||[]),...list.filter(record=>!order.includes(record.ipa))];
  const groupRank=new Map(order.map((ipa,index)=>[ipa,index+1]));
  entries.euler=ordered.map(record=>({...record,rank:groupRank.get(record.ipa)||order.length+1}));
}

function ensureProjectNoun(entries) {
  const list=entries.project ||= [];
  let record=list.find(item=>item.ipa==='/ˈprɑːdʒekt/'&&item.origin==='source-audited');
  if(!record) record={
    headword:'project',ipa:'/ˈprɑːdʒekt/',pos:'noun',posLabel:'名',accent:'General-American',
    tags:['US'],source:cambridge('project'),sources:[cambridge('project')],originalTags:['US'],
    origin:'source-audited',reviewVersion:'cambridge-us-2026-09-23',sourceRevision:'checked-2026-09-23',
    rawPronunciation:'/ˈprɑː.dʒekt/',conversionVersion:'learner-us-1',
    calibrationNote:'Cambridge US explicitly labels /ˈprɑː.dʒekt/ as the noun pronunciation of project.'
  };
  entries.project=[record,...list.filter(item=>item!==record)].map((item,index)=>({...item,rank:index+1}));
}

function ensureSourceRecord(entries, word, ipa, {pos='', posLabel='', sourceUrl=cambridge(word), note}) {
  const list=entries[word.toLowerCase()] ||= [];
  let record=list.find(item=>item.ipa===ipa && item.pos===pos);
  if(!record) {
    record={headword:word.toLowerCase(),ipa,pos,posLabel,accent:'General-American',tags:['US'],source:sourceUrl,sources:[sourceUrl],originalTags:['US'],origin:'source-audited',reviewVersion:'cambridge-us-2026-09-23',sourceRevision:'checked-2026-09-23',rawPronunciation:ipa,conversionVersion:'learner-us-1'};
    list.push(record);
  }
  record.auditSources=[...new Set([...(record.auditSources||[]),sourceUrl])];
  record.sourceAuditVersion='cambridge-us-2026-09-23';
  record.calibrationNote=note;
  entries[word.toLowerCase()]=list.map((item,index)=>({...item,rank:index+1}));
}

function calibrateHighFrequencyFunctionWords(entries) {
  annotateRecords(entries,'abnormal',{'/æbˈnɔːrməl/':{sources:[cambridge('abnormal')],note:'Cambridge US lists /æbˈnɔːr.məl/; syllable separator omitted in reader display.'}});
  ensureSourceRecord(entries,'absolute','/ˈæbsəluːt/',{note:'Cambridge US lists /ˈæb.sə.luːt/; syllable dots omitted in reader display.'});
  promote(entries,'absolute','/ˈæbsəluːt/',{calibrationNote:'Cambridge US lists /ˈæb.sə.luːt/; promoted as the source-backed main reading. Existing alternative stress candidates are retained pending further source review.'});
  annotateRecords(entries,'absolutely',{'/ˌæbsəˈluːtli/':{sources:[cambridge('absolutely')],note:'Cambridge US lists /ˌæb.səˈluːt.li/; syllable dots omitted in reader display.'}});
  const absorptionUrl='https://dictionary.cambridge.org/us/dictionary/english/absorption';
  ensureSourceRecord(entries,'absorption','/æbˈzɔːrpʃən/',{sourceUrl:absorptionUrl,note:'Cambridge US Intermediate lists æb- as an alternative onset in /əbˈzɔrp·ʃən, æb-, -ˈsɔrp-/. Vowel length and syllable dots normalized.'});
  annotateRecords(entries,'absorption',{
    '/əbˈzɔːrpʃən/':{sources:[cambridge('absorption'),absorptionUrl],note:'Cambridge US pronunciation and US Dictionary list /əbˈzɔːrpʃən/.'},
    '/əbˈsɔːrpʃən/':{sources:[absorptionUrl],note:'Cambridge US Dictionary lists the /s/ variant -ˈsɔrp-.'},
    '/æbˈzɔːrpʃən/':{sources:[absorptionUrl],note:'Cambridge US Dictionary lists æb- as an alternative onset.'}
  },'multi-source-us-2026-09-23');
  const absorptionGroups=new Map();for(const record of entries.absorption){const group=absorptionGroups.get(record.ipa)||[];group.push(record);absorptionGroups.set(record.ipa,group);}
  const absorptionOrder=['/əbˈzɔːrpʃən/','/əbˈsɔːrpʃən/','/æbˈzɔːrpʃən/'];entries.absorption=[...absorptionOrder.flatMap(ipa=>absorptionGroups.get(ipa)||[]),...entries.absorption.filter(record=>!absorptionOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(entries,'aesthetic',{'/esˈθetɪk/':{sources:[cambridge('aesthetic')],note:'Cambridge US lists /esˈθet̬.ɪk/; the reader omits the alveolar flap marker.'}});
  annotateRecords(entries,'an',{
    '/æn/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/an','https://dictionary.cambridge.org/us/dictionary/english/an'],note:'Cambridge US lists strong /æn/ for an.'},
    '/ən/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/an','https://dictionary.cambridge.org/us/dictionary/english/an'],note:'Cambridge US lists weak /ən/ for an.'}
  },'multi-source-us-2026-09-23');
  const anGroups=new Map();for(const record of entries.an){const group=anGroups.get(record.ipa)||[];group.push(record);anGroups.set(record.ipa,group);}
  const anOrder=['/æn/','/ən/'];entries.an=[...anOrder.flatMap(ipa=>anGroups.get(ipa)||[]),...entries.an.filter(record=>!anOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  const toList=entries.to ||= [];
  entries.to=toList.filter(record=>!(record.origin==='local-calibration'&&record.ipa==='/tʊ/'));
  entries.to=entries.to.filter(record=>!(record.origin==='local-calibration'&&record.ipa==='/toʊ/'));
  for(const record of entries.to)if(record.ipa==='/toʊ/'&&record.origin==='wiktionary')record.headword='To';
  ensureSourceRecord(entries,'to','/t̬ə/',{note:'Cambridge US lists weak /t̬ə/; its flap marker is preserved.'});
  ensureSourceRecord(entries,'to','/tu/',{note:'Cambridge US lists weak /tu/.'});
  annotateRecords(entries,'to',{
    '/tuː/':{sources:[cambridge('to')],note:'Cambridge US lists strong /tuː/.'},
    '/tə/':{sources:[cambridge('to')],note:'Cambridge US lists weak /tə/.'},
    '/t̬ə/':{sources:[cambridge('to')],note:'Cambridge US lists weak /t̬ə/.'},
    '/tu/':{sources:[cambridge('to')],note:'Cambridge US lists weak /tu/.'}
  });
  const toGroups=new Map();for(const record of entries.to){const group=toGroups.get(record.ipa)||[];group.push(record);toGroups.set(record.ipa,group);}
  const toOrder=['/tuː/','/tə/','/t̬ə/','/tu/','/toʊ/'];entries.to=[...toOrder.flatMap(ipa=>toGroups.get(ipa)||[]),...entries.to.filter(record=>!toOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(entries,'that',{
    '/ðæt/':{sources:[cambridge('that')],note:'Cambridge US lists /ðæt/ as strong form and for determiner/adverb.'},
    '/ðət/':{sources:[cambridge('that')],note:'Cambridge US lists weak /ðət/ for conjunction and pronoun.'}
  });
  ensureSourceRecord(entries,'and','/ən/',{note:'Cambridge US lists weak /ən/.'});
  annotateRecords(entries,'and',{
    '/ænd/':{sources:[cambridge('and')],note:'Cambridge US lists strong /ænd/.'},
    '/ənd/':{sources:[cambridge('and')],note:'Cambridge US lists weak /ənd/.'},
    '/ən/':{sources:[cambridge('and')],note:'Cambridge US lists weak /ən/.'}
  });
  const andGroups=new Map();for(const record of entries.and){const group=andGroups.get(record.ipa)||[];group.push(record);andGroups.set(record.ipa,group);}
  const andOrder=['/ænd/','/ənd/','/ən/'];entries.and=[...andOrder.flatMap(ipa=>andGroups.get(ipa)||[]),...entries.and.filter(record=>!andOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(entries,'a',{
    '/ə/':{sources:[cambridge('a')],note:'Cambridge US lists weak /ə/ for the article.'},
    '/eɪ/':{sources:[cambridge('a')],note:'Cambridge US lists strong /eɪ/ for the article and the letter name.'}
  });
  annotateRecords(entries,'for',{
    '/fɔːr/':{sources:[cambridge('for')],note:'Cambridge US lists strong /fɔːr/ for for; retained as the first, citation-style form.'},
    '/fər/':{sources:[cambridge('for')],note:'Cambridge US lists weak /fɚ/; normalized to the project IPA display /fər/.'}
  });
  annotateRecords(entries,'her',{
    '/hɜːr/':{sources:[cambridge('her')],note:'Cambridge US lists strong /hɝː/; normalized to the project IPA display /hɜːr/.'},
    '/hər/':{sources:[cambridge('her')],note:'Cambridge US lists weak /hɚ/; normalized to the project IPA display /hər/.'},
    '/ər/':{sources:[cambridge('her')],note:'Cambridge US lists weak /ɚ/; normalized to the project IPA display /ər/.'}
  });
  annotateRecords(entries,'on',{
    '/ɑːn/':{sources:[cambridge('on'),'https://www.collinsdictionary.com/us/dictionary/english/on'],note:'Cambridge US lists /ɑːn/; Collins American English also lists /ɑn/.'},
    '/ɔːn/':{sources:['https://www.collinsdictionary.com/us/dictionary/english/on'],note:'Collins American English explicitly lists /ɔn/ as a US variant; normalized to the project IPA display /ɔːn/.'}
  },'multi-source-us-2026-09-23');
  ensureSourceRecord(entries,'of','/əv/',{note:'Cambridge US lists weak /əv/ for of.'});
  ensureSourceRecord(entries,'of','/ɑːv/',{note:'Cambridge US lists strong /ɑːv/ for of.'});
  annotateRecords(entries,'of',{
    '/əv/':{sources:[cambridge('of')],note:'Cambridge US lists weak /əv/; promoted as the ordinary unstressed reading.'},
    '/ʌv/':{sources:['https://www.collinsdictionary.com/us/dictionary/english/of'],note:'Collins American English lists strong /ʌv/; retained as a strong form.'},
    '/ɑːv/':{sources:[cambridge('of'),'https://www.collinsdictionary.com/us/dictionary/english/of'],note:'Cambridge US lists strong /ɑːv/; Collins also lists /ɑv/.'}
  },'multi-source-us-2026-09-23');
  const ofGroups=new Map();for(const record of entries.of){const group=ofGroups.get(record.ipa)||[];group.push(record);ofGroups.set(record.ipa,group);}
  const ofOrder=['/əv/','/ʌv/','/ɑːv/'];entries.of=[...ofOrder.flatMap(ipa=>ofGroups.get(ipa)||[]),...entries.of.filter(record=>!ofOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(entries,'in',{
    '/ɪn/':{sources:[cambridge('in')],note:'Cambridge US pronunciation page lists /ɪn/; verified with no additional citation-form variant.'}
  });
  annotateRecords(entries,'the',{
    '/ðə/':{sources:[cambridge('the')],note:'Cambridge US lists weak /ðə/.'},
    '/ðiː/':{sources:[cambridge('the')],note:'Cambridge US lists strong /ðiː/.'}
  });
  ensureSourceRecord(entries,'you','/ju/',{pos:'pron',posLabel:'代',note:'Cambridge Learner’s Dictionary lists weak /ju/ for the US pronoun you.'});
  ensureSourceRecord(entries,'you','/jʊ/',{pos:'pron',posLabel:'代',note:'Cambridge US dictionary lists /jʊ/ as an additional pronunciation of you.'});
  annotateRecords(entries,'you',{
    '/juː/':{sources:[cambridge('you')],note:'Cambridge US lists /juː/ as the strong form.'},
    '/ju/':{sources:[cambridge('you')],note:'Cambridge Learner’s US entry lists weak /ju/.'},
    '/jə/':{sources:[cambridge('you')],note:'Cambridge US lists /jə/ as a weak pronunciation.'},
    '/jʊ/':{sources:[cambridge('you')],note:'Cambridge US lists /jʊ/ as an additional pronunciation.'}
  });
  const youGroups=new Map();for(const record of entries.you){const group=youGroups.get(record.ipa)||[];group.push(record);youGroups.set(record.ipa,group);}
  const youOrder=['/juː/','/ju/','/jə/','/jʊ/'];entries.you=[...youOrder.flatMap(ipa=>youGroups.get(ipa)||[]),...entries.you.filter(record=>!youOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'we','/wi/',{pos:'pron',posLabel:'代',note:'Cambridge US lists weak /wi/ for the pronoun we.'});
  annotateRecords(entries,'we',{
    '/wiː/':{sources:[cambridge('we')],note:'Cambridge US lists strong /wiː/.'},
    '/wi/':{sources:[cambridge('we')],note:'Cambridge US lists weak /wi/.'}
  });
  const weGroups=new Map();for(const record of entries.we){const group=weGroups.get(record.ipa)||[];group.push(record);weGroups.set(record.ipa,group);}
  const weOrder=['/wiː/','/wi/'];entries.we=[...weOrder.flatMap(ipa=>weGroups.get(ipa)||[]),...entries.we.filter(record=>!weOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(entries,'it',{
    '/ɪt/':{sources:[cambridge('it')],note:'Cambridge US pronunciation page lists /ɪt/.'},
    '/ət/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/it'],note:'Cambridge Intermediate US entry lists /ət/ as an additional pronunciation.'}
  });
  ensureSourceRecord(entries,'from','/frəm/',{pos:'prep',posLabel:'介',note:'Cambridge US lists weak /frəm/ for from.'});
  ensureSourceRecord(entries,'from','/frɑm/',{pos:'prep',posLabel:'介',note:'Cambridge US Intermediate entry lists /frɑm/ as an additional American pronunciation.'});
  annotateRecords(entries,'from',{
    '/frʌm/':{sources:[cambridge('from')],note:'Cambridge US lists strong /frʌm/.'},
    '/frəm/':{sources:[cambridge('from')],note:'Cambridge US lists weak /frəm/.'},
    '/frɑm/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/from'],note:'Cambridge US Intermediate entry lists /frɑm/ as a variant.'}
  });
  const fromGroups=new Map();for(const record of entries.from){const group=fromGroups.get(record.ipa)||[];group.push(record);fromGroups.set(record.ipa,group);}
  const fromOrder=['/frʌm/','/frəm/','/frɑm/'];entries.from=[...fromOrder.flatMap(ipa=>fromGroups.get(ipa)||[]),...entries.from.filter(record=>!fromOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'at','/ət/',{note:'Cambridge US lists weak /ət/ for at.'});
  annotateRecords(entries,'at',{
    '/æt/':{sources:[cambridge('at')],note:'Cambridge US lists strong /æt/.'},
    '/ət/':{sources:[cambridge('at')],note:'Cambridge US lists weak /ət/.'}
  });
  const atGroups=new Map();for(const record of entries.at){const group=atGroups.get(record.ipa)||[];group.push(record);atGroups.set(record.ipa,group);}
  const atOrder=['/æt/','/ət/'];entries.at=[...atOrder.flatMap(ipa=>atGroups.get(ipa)||[]),...entries.at.filter(record=>!atOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(entries,'as',{
    '/æz/':{sources:[cambridge('as')],note:'Cambridge US lists strong /æz/.'},
    '/əz/':{sources:[cambridge('as')],note:'Cambridge US lists weak /əz/.'}
  });
  annotateRecords(entries,'by',{
    '/baɪ/':{sources:[cambridge('by')],note:'Cambridge US lists /baɪ/.'}
  });
  ensureSourceRecord(entries,'have','/həv/',{note:'Cambridge US lists weak /həv/ for have.'});
  ensureSourceRecord(entries,'have','/əv/',{note:'Cambridge US lists weak /əv/ for have.'});
  ensureSourceRecord(entries,'have','/v/',{note:'Cambridge US Intermediate lists weak /v/ for have.'});
  annotateRecords(entries,'have',{
    '/hæv/':{sources:[cambridge('have')],note:'Cambridge US lists strong /hæv/.'},
    '/həv/':{sources:[cambridge('have')],note:'Cambridge US lists weak /həv/.'},
    '/əv/':{sources:[cambridge('have')],note:'Cambridge US lists weak /əv/.'},
    '/v/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/have'],note:'Cambridge US Intermediate lists weak /v/.'}
  });
  const haveGroups=new Map();for(const record of entries.have){const group=haveGroups.get(record.ipa)||[];group.push(record);haveGroups.set(record.ipa,group);}
  const haveOrder=['/hæv/','/həv/','/əv/','/v/'];entries.have=[...haveOrder.flatMap(ipa=>haveGroups.get(ipa)||[]),...entries.have.filter(record=>!haveOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'has','/əz/',{note:'Cambridge US lists weak /əz/ for has.'});
  annotateRecords(entries,'has',{
    '/hæz/':{sources:[cambridge('has')],note:'Cambridge US lists strong /hæz/.'},
    '/həz/':{sources:[cambridge('has')],note:'Cambridge US lists weak /həz/.'},
    '/əz/':{sources:[cambridge('has')],note:'Cambridge US lists weak /əz/.'}
  });
  const hasGroups=new Map();for(const record of entries.has){const group=hasGroups.get(record.ipa)||[];group.push(record);hasGroups.set(record.ipa,group);}
  const hasOrder=['/hæz/','/həz/','/əz/'];entries.has=[...hasOrder.flatMap(ipa=>hasGroups.get(ipa)||[]),...entries.has.filter(record=>!hasOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'was','/wʌz/',{note:'Cambridge US Intermediate lists /wʌz/ as a variant of was.'});
  annotateRecords(entries,'was',{
    '/wɑːz/':{sources:[cambridge('was'),'https://dictionary.cambridge.org/us/dictionary/english/was'],note:'Cambridge US pronunciation page lists /wɑːz/; US Intermediate also lists /wɑz/.'},
    '/wəz/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/was'],note:'Cambridge US Intermediate lists weak /wəz/.'},
    '/wʌz/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/was'],note:'Cambridge US Intermediate lists /wʌz/.'}
  });
  const wasGroups=new Map();for(const record of entries.was){const group=wasGroups.get(record.ipa)||[];group.push(record);wasGroups.set(record.ipa,group);}
  const wasOrder=['/wɑːz/','/wəz/','/wʌz/'];entries.was=[...wasOrder.flatMap(ipa=>wasGroups.get(ipa)||[]),...entries.was.filter(record=>!wasOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'were','/wər/',{note:'Cambridge US dictionary lists weak /wɚ/, normalized to the project IPA display /wər/.'});
  annotateRecords(entries,'were',{
    '/wɜːr/':{sources:[cambridge('were')],note:'Cambridge US dictionary lists strong /wɝː/, normalized to the project IPA display /wɜːr/.'},
    '/wər/':{sources:['https://dictionary.cambridge.org/pronunciation/english/were'],note:'Cambridge US pronunciation page lists /wɚ/, normalized to the project IPA display /wər/.'}
  });
  const wereGroups=new Map();for(const record of entries.were){const group=wereGroups.get(record.ipa)||[];group.push(record);wereGroups.set(record.ipa,group);}
  const wereOrder=['/wɜːr/','/wər/'];entries.were=[...wereOrder.flatMap(ipa=>wereGroups.get(ipa)||[]),...entries.were.filter(record=>!wereOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'do','/də/',{pos:'verb',posLabel:'动',note:'Cambridge US lists /də/ for the auxiliary and lexical verb do.'});
  ensureSourceRecord(entries,'do','/du/',{pos:'verb',posLabel:'动',note:'Cambridge US lists /du/ as a pronunciation of the auxiliary and lexical verb do.'});
  ensureSourceRecord(entries,'do','/duː/',{pos:'verb',posLabel:'动',note:'Cambridge US lists /duː/ for do as a verb.'});
  ensureSourceRecord(entries,'do','/duː/',{pos:'noun',posLabel:'名',note:'Cambridge US lists /duː/ for the noun do meaning hairdo.'});
  ensureSourceRecord(entries,'do','/doʊ/',{pos:'noun',posLabel:'名',note:'Cambridge US lists /doʊ/ for the musical note do.'});
  annotateRecords(entries,'do',{
    '/də/':{sources:[cambridge('do')],note:'Cambridge US lists /də/ for the auxiliary verb and the main verb.'},
    '/du/':{sources:[cambridge('do')],note:'Cambridge US lists /du/ for the auxiliary verb and the main verb.'},
    '/duː/':{sources:[cambridge('do'),'https://dictionary.cambridge.org/us/dictionary/english/do'],note:'Cambridge US lists /duː/ for the verb and for a noun sense.'},
    '/doʊ/':{sources:[cambridge('do'),'https://dictionary.cambridge.org/us/dictionary/english/do'],note:'Cambridge US lists /doʊ/ for do as the musical note.'}
  },'multi-source-us-2026-09-23');
  const doGroups=new Map();for(const record of entries.do){const group=doGroups.get(record.ipa)||[];group.push(record);doGroups.set(record.ipa,group);}
  const doOrder=['/də/','/du/','/duː/','/doʊ/'];entries.do=[...doOrder.flatMap(ipa=>doGroups.get(ipa)||[]),...entries.do.filter(record=>!doOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'does','/dʌz/',{pos:'verb',posLabel:'动',note:'Cambridge US lists strong /dʌz/ for does as the third-person form of do.'});
  ensureSourceRecord(entries,'does','/dəz/',{pos:'verb',posLabel:'动',note:'Cambridge US lists weak /dəz/ for does as the third-person form of do.'});
  annotateRecords(entries,'does',{
    '/dʌz/':{sources:[cambridge('does')],note:'Cambridge US lists strong /dʌz/ for the verb does.'},
    '/dəz/':{sources:[cambridge('does')],note:'Cambridge US lists weak /dəz/ for the verb does.'},
    '/doʊz/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/doe','https://www.dictionary.com/browse/doe?q=DOE','https://en.wiktionary.org/wiki/does#English'],note:'The separate noun does is the plural of doe. Cambridge US and Dictionary.com give doe as /doʊ/ and identify does as its plural; Wiktionary records this homograph as General American /doʊz/.'}
  },'multi-source-us-2026-09-23');
  const doesGroups=new Map();for(const record of entries.does){const group=doesGroups.get(record.ipa)||[];group.push(record);doesGroups.set(record.ipa,group);}
  const doesOrder=['/dʌz/','/dəz/','/doʊz/'];entries.does=[...doesOrder.flatMap(ipa=>doesGroups.get(ipa)||[]),...entries.does.filter(record=>!doesOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(entries,'did',{
    '/dɪd/':{sources:[cambridge('did')],note:'Cambridge US lists /dɪd/; no distinct common weak form is listed in the checked US entry.'}
  });
  ensureSourceRecord(entries,'can','/kən/',{note:'Cambridge US explicitly lists weak /kən/ for modal can.'});
  annotateRecords(entries,'can',{
    '/kæn/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/can','https://dictionary.cambridge.org/us/pronunciation/english/can'],note:'Cambridge US lists strong /kæn/ for modal can.'},
    '/kən/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/can','https://dictionary.cambridge.org/us/pronunciation/english/can'],note:'Cambridge US explicitly lists weak /kən/ for modal can.'}
  },'cambridge-us-2026-09-23');
  const canGroups=new Map();for(const record of entries.can){const group=canGroups.get(record.ipa)||[];group.push(record);canGroups.set(record.ipa,group);}
  const canOrder=['/kæn/','/kən/'];entries.can=[...canOrder.flatMap(ipa=>canGroups.get(ipa)||[]),...entries.can.filter(record=>!canOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'could','/kəd/',{note:'Cambridge US explicitly lists weak /kəd/ for the modal verb could.'});
  annotateRecords(entries,'could',{
    '/kʊd/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/could','https://dictionary.cambridge.org/us/pronunciation/english/could'],note:'Cambridge US lists strong /kʊd/ for could.'},
    '/kəd/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/could','https://dictionary.cambridge.org/us/pronunciation/english/could'],note:'Cambridge US explicitly lists weak /kəd/ for could.'}
  },'cambridge-us-2026-09-23');
  const couldGroups=new Map();for(const record of entries.could){const group=couldGroups.get(record.ipa)||[];group.push(record);couldGroups.set(record.ipa,group);}
  const couldOrder=['/kʊd/','/kəd/'];entries.could=[...couldOrder.flatMap(ipa=>couldGroups.get(ipa)||[]),...entries.could.filter(record=>!couldOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'must','/məst/',{note:'Cambridge US explicitly lists weak /məst/ for must.'});
  ensureSourceRecord(entries,'must','/məs/',{note:'Cambridge US explicitly lists weak /məs/ for must.'});
  annotateRecords(entries,'must',{
    '/mʌst/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/must','https://dictionary.cambridge.org/us/pronunciation/english/must'],note:'Cambridge US lists strong /mʌst/ for must.'},
    '/məst/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/must','https://dictionary.cambridge.org/us/pronunciation/english/must'],note:'Cambridge US explicitly lists weak /məst/ for must.'},
    '/məs/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/must','https://dictionary.cambridge.org/us/pronunciation/english/must'],note:'Cambridge US explicitly lists weak /məs/ for must.'}
  },'cambridge-us-2026-09-23');
  const mustGroups=new Map();for(const record of entries.must){const group=mustGroups.get(record.ipa)||[];group.push(record);mustGroups.set(record.ipa,group);}
  const mustOrder=['/mʌst/','/məst/','/məs/'];entries.must=[...mustOrder.flatMap(ipa=>mustGroups.get(ipa)||[]),...entries.must.filter(record=>!mustOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'will','/wəl/',{note:'Cambridge Learner’s US lists /wəl/ as an additional pronunciation of modal will.'});
  annotateRecords(entries,'will',{
    '/wɪl/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/will','https://dictionary.cambridge.org/us/dictionary/learner-english/will'],note:'Cambridge US lists /wɪl/ as the strong form of modal will.'},
    '/wəl/':{sources:['https://dictionary.cambridge.org/us/dictionary/learner-english/will'],note:'Cambridge Learner’s US lists /wəl/ as a reduced form of modal will.'}
  },'cambridge-us-2026-09-23');
  const willGroups=new Map();for(const record of entries.will){const group=willGroups.get(record.ipa)||[];group.push(record);willGroups.set(record.ipa,group);}
  const willOrder=['/wɪl/','/wəl/'];entries.will=[...willOrder.flatMap(ipa=>willGroups.get(ipa)||[]),...entries.will.filter(record=>!willOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'would','/wəd/',{note:'Cambridge US explicitly lists weak /wəd/ for the modal would.'});
  annotateRecords(entries,'would',{
    '/wʊd/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/would','https://dictionary.cambridge.org/us/dictionary/learner-english/would'],note:'Cambridge US lists strong /wʊd/ for would.'},
    '/wəd/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/would','https://dictionary.cambridge.org/us/dictionary/learner-english/would'],note:'Cambridge US explicitly lists weak /wəd/ for would; the separately marked UK weak form /əd/ is excluded.'}
  },'cambridge-us-2026-09-23');
  const wouldGroups=new Map();for(const record of entries.would){const group=wouldGroups.get(record.ipa)||[];group.push(record);wouldGroups.set(record.ipa,group);}
  const wouldOrder=['/wʊd/','/wəd/'];entries.would=[...wouldOrder.flatMap(ipa=>wouldGroups.get(ipa)||[]),...entries.would.filter(record=>!wouldOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'should','/ʃəd/',{note:'Cambridge US explicitly lists weak /ʃəd/ for should.'});
  annotateRecords(entries,'should',{
    '/ʃʊd/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/should','https://dictionary.cambridge.org/us/pronunciation/english/should'],note:'Cambridge US lists strong /ʃʊd/ for should.'},
    '/ʃəd/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/should','https://dictionary.cambridge.org/us/pronunciation/english/should'],note:'Cambridge US explicitly lists weak /ʃəd/ for should.'}
  },'cambridge-us-2026-09-23');
  const shouldGroups=new Map();for(const record of entries.should){const group=shouldGroups.get(record.ipa)||[];group.push(record);shouldGroups.set(record.ipa,group);}
  const shouldOrder=['/ʃʊd/','/ʃəd/'];entries.should=[...shouldOrder.flatMap(ipa=>shouldGroups.get(ipa)||[]),...entries.should.filter(record=>!shouldOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(entries,'may',{
    '/meɪ/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/may'],note:'Cambridge US lists /meɪ/; no separate weak form is listed in the checked US pronunciation entry.'}
  });
  annotateRecords(entries,'might',{
    '/maɪt/':{sources:['https://dictionary.cambridge.org/pronunciation/american-english/might','https://www.collinsdictionary.com/us/dictionary/english/might'],note:'Cambridge American pronunciation and Collins American English list /maɪt/; neither checked entry lists a separate weak form.'}
  },'multi-source-us-2026-09-23');
  ensureSourceRecord(entries,'shall','/ʃəl/',{note:'Cambridge US explicitly lists weak /ʃəl/ for shall.'});
  annotateRecords(entries,'shall',{
    '/ʃæl/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/shall','https://dictionary.cambridge.org/us/pronunciation/english/shall'],note:'Cambridge US lists strong /ʃæl/ for shall.'},
    '/ʃəl/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/shall','https://dictionary.cambridge.org/us/pronunciation/english/shall'],note:'Cambridge US explicitly lists weak /ʃəl/ for shall.'}
  },'cambridge-us-2026-09-23');
  const shallGroups=new Map();for(const record of entries.shall){const group=shallGroups.get(record.ipa)||[];group.push(record);shallGroups.set(record.ipa,group);}
  const shallOrder=['/ʃæl/','/ʃəl/'];entries.shall=[...shallOrder.flatMap(ipa=>shallGroups.get(ipa)||[]),...entries.shall.filter(record=>!shallOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'be','/bɪ/',{note:'Cambridge US explicitly lists weak /bɪ/ for be.'});
  annotateRecords(entries,'be',{
    '/biː/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/be'],note:'Cambridge US lists strong /biː/ for be.'},
    '/bi/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/be'],note:'Cambridge US lists weak /bi/ for be.'},
    '/bɪ/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/be'],note:'Cambridge US lists weak /bɪ/ for be.'}
  });
  const beGroups=new Map();for(const record of entries.be){const group=beGroups.get(record.ipa)||[];group.push(record);beGroups.set(record.ipa,group);}
  const beOrder=['/biː/','/bi/','/bɪ/'];entries.be=[...beOrder.flatMap(ipa=>beGroups.get(ipa)||[]),...entries.be.filter(record=>!beOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'had','/həd/',{note:'Cambridge US explicitly lists weak /həd/ for had.'});
  ensureSourceRecord(entries,'had','/əd/',{note:'Cambridge US pronunciation page explicitly lists weak /əd/ for had.'});
  annotateRecords(entries,'had',{
    '/hæd/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/had','https://dictionary.cambridge.org/us/dictionary/english/had'],note:'Cambridge US lists strong /hæd/ for had.'},
    '/həd/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/had','https://dictionary.cambridge.org/us/dictionary/english/had'],note:'Cambridge US explicitly lists weak /həd/ for had.'},
    '/əd/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/had','https://dictionary.cambridge.org/us/dictionary/english/had'],note:'Cambridge US pronunciation page explicitly lists weak /əd/ for had.'}
  },'cambridge-us-2026-09-23');
  const hadGroups=new Map();for(const record of entries.had){const group=hadGroups.get(record.ipa)||[];group.push(record);hadGroups.set(record.ipa,group);}
  const hadOrder=['/hæd/','/həd/','/əd/'];entries.had=[...hadOrder.flatMap(ipa=>hadGroups.get(ipa)||[]),...entries.had.filter(record=>!hadOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'he','/hi/',{note:'Cambridge US explicitly lists weak /hi/ for the pronoun he.'});
  ensureSourceRecord(entries,'he','/i/',{note:'Cambridge US explicitly lists weak /i/ for the pronoun he.'});
  annotateRecords(entries,'he',{
    '/hiː/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/he'],note:'Cambridge US lists strong /hiː/ for the pronoun he.'},
    '/hi/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/he'],note:'Cambridge US explicitly lists weak /hi/ for the pronoun he.'},
    '/i/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/he'],note:'Cambridge US explicitly lists weak /i/ for the pronoun he.'}
  });
  const heGroups=new Map();for(const record of entries.he){const group=heGroups.get(record.ipa)||[];group.push(record);heGroups.set(record.ipa,group);}
  const heOrder=['/hiː/','/hi/','/i/'];entries.he=[...heOrder.flatMap(ipa=>heGroups.get(ipa)||[]),...entries.he.filter(record=>!heOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'she','/ʃi/',{note:'Cambridge US explicitly lists weak /ʃi/ for she.'});
  annotateRecords(entries,'she',{
    '/ʃiː/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/she'],note:'Cambridge US lists strong /ʃiː/ for she.'},
    '/ʃi/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/she'],note:'Cambridge US explicitly lists weak /ʃi/ for she.'}
  });
  const sheGroups=new Map();for(const record of entries.she){const group=sheGroups.get(record.ipa)||[];group.push(record);sheGroups.set(record.ipa,group);}
  const sheOrder=['/ʃiː/','/ʃi/'];entries.she=[...sheOrder.flatMap(ipa=>sheGroups.get(ipa)||[]),...entries.she.filter(record=>!sheOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'is','/əz/',{note:'Cambridge US Intermediate lists /əz/ as an American pronunciation of is.'});
  ensureSourceRecord(entries,'is','/z/',{note:'Cambridge US explicitly lists weak /z/ for is.'});
  ensureSourceRecord(entries,'is','/s/',{note:'Cambridge US explicitly lists weak /s/ for is.'});
  annotateRecords(entries,'is',{
    '/ɪz/':{sources:['https://dictionary.cambridge.org/pronunciation/english/is','https://dictionary.cambridge.org/us/dictionary/english/is'],note:'Cambridge US lists strong /ɪz/ for is.'},
    '/əz/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/is'],note:'Cambridge US Intermediate lists /əz/.'},
    '/z/':{sources:['https://dictionary.cambridge.org/pronunciation/english/is','https://dictionary.cambridge.org/us/dictionary/english/is'],note:'Cambridge US explicitly lists weak /z/.'},
    '/s/':{sources:['https://dictionary.cambridge.org/pronunciation/english/is','https://dictionary.cambridge.org/us/dictionary/english/is'],note:'Cambridge US explicitly lists weak /s/.'}
  },'multi-source-us-2026-09-23');
  const isGroups=new Map();for(const record of entries.is){const group=isGroups.get(record.ipa)||[];group.push(record);isGroups.set(record.ipa,group);}
  const isOrder=['/ɪz/','/əz/','/z/','/s/'];entries.is=[...isOrder.flatMap(ipa=>isGroups.get(ipa)||[]),...entries.is.filter(record=>!isOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  ensureSourceRecord(entries,'are','/r/',{note:'Cambridge US Intermediate lists /r/ as a reduced pronunciation of are.'});
  annotateRecords(entries,'are',{
    '/ɑːr/':{sources:['https://dictionary.cambridge.org/pronunciation/english/are','https://dictionary.cambridge.org/us/dictionary/english/are'],note:'Cambridge US lists strong /ɑːr/ for are.'},
    '/ər/':{sources:['https://dictionary.cambridge.org/pronunciation/english/are','https://dictionary.cambridge.org/us/dictionary/english/are'],note:'Cambridge US lists weak /ɚ/, normalized to the project display /ər/; Intermediate US independently lists /ər/.'},
    '/r/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/are'],note:'Cambridge US Intermediate lists /r/.'}
  },'multi-source-us-2026-09-23');
  const areGroups=new Map();for(const record of entries.are){const group=areGroups.get(record.ipa)||[];group.push(record);areGroups.set(record.ipa,group);}
  const areOrder=['/ɑːr/','/ər/','/r/'];entries.are=[...areOrder.flatMap(ipa=>areGroups.get(ipa)||[]),...entries.are.filter(record=>!areOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(entries,'being',{
    '/ˈbiːɪŋ/':{sources:['https://dictionary.cambridge.org/us/pronunciation/english/being'],note:'Cambridge US lists /ˈbiː.ɪŋ/; syllable separator omitted in reader display.'}
  });
  annotateRecords(entries,'doing',{
    '/ˈduːɪŋ/':{sources:['https://dictionary.cambridge.org/pronunciation/english/doing'],note:'Cambridge US lists /ˈduː.ɪŋ/; syllable separator omitted in reader display.'}
  });
  const sayUrl='https://www.oxfordlearnersdictionaries.com/us/definition/english/say_1';
  annotateRecords(entries,'say',{'/seɪ/':{sources:[sayUrl],note:'Oxford American lists /seɪ/ for say.'}},'oxford-american-2026-09-23');
  annotateRecords(entries,'said',{'/sed/':{sources:[sayUrl],note:'Oxford American lists /sed/ for both past simple and past participle said.'}},'oxford-american-2026-09-23');
  annotateRecords(entries,'saying',{'/ˈseɪɪŋ/':{sources:[sayUrl,'https://www.oxfordlearnersdictionaries.com/us/definition/american_english/saying'],note:'Oxford American verb -ing form and noun entry both list /ˈseɪɪŋ/; syllable dot omitted in reader display.'}},'oxford-american-2026-09-23');
  annotateRecords(entries,'says',{'/sez/':{sources:[sayUrl,'https://dictionary.cambridge.org/us/pronunciation/english/says'],note:'Oxford American and Cambridge US both list /sez/. The additional local /sɪz/ candidate remains unresolved.'}},'multi-source-us-2026-09-23');
}

function annotateRecords(entries, word, ipaSources, auditVersion='cambridge-us-2026-09-23') {
  const list=entries[word.toLowerCase()]||[];
  for(const record of list) {
    const evidence=ipaSources[record.ipa];if(!evidence)continue;
    record.auditSources=[...new Set([...(record.auditSources||[]),...evidence.sources])];
    record.sourceAuditVersion=auditVersion;
    if(record.origin==='local-calibration'&&record.source==='deepseek-flash')record.reviewVersion='deepseek-review-1';
    record.calibrationNote=evidence.note;
  }
}

const raw = JSON.parse(await readFile(rawFile, 'utf8'));
const canonical = JSON.parse(await readFile(canonicalFile, 'utf8'));
updateCelestial(raw.entries);
updateCelestial(canonical.entries);
updateCopenhagen(raw.entries);
updateCopenhagen(canonical.entries);
for (const data of [raw.entries, canonical.entries]) {
  promote(data, 'Europe', '/ˈjʊrəp/');
  promote(data, 'Paris', '/ˈperɪs/');
  promote(data, 'Israel', '/ˈɪzriəl/', {
    sourceUrl:'https://www.oxfordlearnersdictionaries.com/us/definition/american_english/israel',
    reviewVersion:'multi-source-us-2026-09-23',
    calibrationNote:'Oxford NAmE and Collins American English list /ˈɪzriəl/; Cambridge also lists /ˈɪzreɪl/. Promoted the form listed by both American dictionaries, retaining the Cambridge-listed variant.'
  });
  promote(data, 'Jupiter', '/ˈdʒuːpətər/');
  promote(data, 'again', '/əˈɡen/', {calibrationNote:'Cambridge US lists /əˈɡen/; promoted as the primary US reading. Cambridge Academic Content also lists /əˈɡeɪn/, which remains as a sourced variant.'});
  annotateRecords(data,'human',{
    '/ˈhjuːmən/':{sources:[cambridge('human')],note:'Cambridge US lists /ˈhjuː.mən/; syllable dot normalized.'}
  });
  promote(data, 'because', '/bɪˈkʌz/', {calibrationNote:'Cambridge US lists /bɪˈkʌz/ for the conjunction and /bɪˈkɑːz/ as an additional US form; /bɪˈkʌz/ promoted for the standard conjunction reading. Other candidates retained pending review.'});
  annotateRecords(data,'because',{
    '/bɪˈkʌz/':{sources:[cambridge('because')],note:'Cambridge US lists /bɪˈkʌz/ for because as a conjunction.'},
    '/bɪˈkɑːz/':{sources:[cambridge('because')],note:'Cambridge US lists /bɪˈkɑːz/ as a US variant, including the informal preposition.'}
  });
  const becauseGroups=new Map();for(const record of data.because){const group=becauseGroups.get(record.ipa)||[];group.push(record);becauseGroups.set(record.ipa,group);}
  const becauseOrder=['/bɪˈkʌz/','/bɪˈkɑːz/','/bɪˈkɔːz/','/bɪkəz/'];data.because=[...becauseOrder.flatMap(ipa=>becauseGroups.get(ipa)||[]),...data.because.filter(record=>!becauseOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(data,'within',{
    '/wɪˈðɪn/':{sources:[cambridge('within')],note:'Cambridge US lists /wɪˈðɪn/; syllable structure normalized.'}
  });
  promote(data, 'either', '/ˈiːðər/', {calibrationNote:'Cambridge US lists /ˈiː.ðɚ/ and /ˈaɪ.ðɚ/ in that order; both variants retained, with the first listed form as the default.'});
  annotateRecords(data,'either',{
    '/ˈiːðər/':{sources:[cambridge('either')],note:'Cambridge US lists /ˈiː.ðɚ/; syllable dot normalized.'},
    '/ˈaɪðər/':{sources:[cambridge('either')],note:'Cambridge US lists /ˈaɪ.ðɚ/ as a variant; syllable dot normalized.'}
  });
  ensureSourceRecord(data,'often','/ˈɑːfən/',{note:'Cambridge US lists /ˈɑːf.ən/; syllable dots and spacing normalized.'});
  ensureSourceRecord(data,'often','/ˈɑːftən/',{note:'Cambridge US lists /ˈɑːf.tən/; syllable dots and spacing normalized.'});
  const oftenGroups=new Map();
  for(const record of data.often){const group=oftenGroups.get(record.ipa)||[];group.push(record);oftenGroups.set(record.ipa,group);}
  const oftenOrder=['/ˈɑːfən/','/ˈɑːftən/','/ˈɔːfən/','/ˈɔːftən/'];
  data.often=[...oftenOrder.flatMap(ipa=>oftenGroups.get(ipa)||[]),...data.often.filter(record=>!oftenOrder.includes(record.ipa))]
    .map((record,index)=>({...record,rank:index+1,calibrationNote:record.ipa.includes('ɑːf')?'Cambridge US lists the /ɑː/ pronunciation; promoted ahead of the /ɔː/ local candidates.':record.calibrationNote}));
  annotateRecords(data,'often',{
    '/ˈɔːfən/':{sources:[cambridge('often')],note:'Cambridge Academic Content lists /ˈɔːfən/; retained as a US regional-vowel variant.'},
    '/ˈɔːftən/':{sources:[cambridge('often')],note:'Cambridge Academic Content lists /ˈɔːftən/; retained as a US regional-vowel variant.'}
  });
  annotateRecords(data,'route',{
    '/ruːt/':{sources:[cambridge('route')],note:'Cambridge US lists /ruːt/ as a US pronunciation.'},
    '/raʊt/':{sources:[cambridge('route')],note:'Cambridge US lists /raʊt/ as an alternate US pronunciation.'}
  });
  annotateRecords(data,'process',{
    '/ˈprɑːses/':{sources:[cambridge('process')],note:'Cambridge US lists /ˈprɑː.ses/ for noun and ordinary verb.'},
    '/prəˈses/':{sources:[cambridge('process')],note:'Cambridge US lists /prəˈses/ for the verb meaning “walk”.'}
  });
  promote(data,'what','/wɑːt/',{calibrationNote:'Cambridge US lists /wɑːt/; local /wʌt/ is retained pending an independent source.'});
  annotateRecords(data,'been',{'/bɪn/':{sources:[cambridge('been')],note:'Cambridge US lists /bɪn/.'}});
  ensureSourceRecord(data,'been','/bɛn/',{note:'Cambridge US lists /ben/; represented in the project’s American IPA style as /bɛn/.'});
  const beenGroups=new Map();for(const record of data.been){const group=beenGroups.get(record.ipa)||[];group.push(record);beenGroups.set(record.ipa,group);}
  const beenOrder=['/bɪn/','/bɛn/','/bən/'];data.been=[...beenOrder.flatMap(ipa=>beenGroups.get(ipa)||[]),...data.been.filter(record=>!beenOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  promote(data,'with','/wɪð/',{calibrationNote:'Cambridge US lists /wɪð/; promoted as the dictionary-supported US form, retaining the General-American /wɪθ/ candidate pending review.'});
  annotateRecords(data,'with',{'/wɪð/':{sources:[cambridge('with')],note:'Cambridge US lists /wɪð/.'}});
  promote(data,'all','/ɑːl/',{calibrationNote:'Cambridge US lists /ɑːl/; promoted as the US dictionary default. The General-American /ɔːl/ candidate is retained pending review.'});
  annotateRecords(data,'before',{'/bɪˈfɔːr/':{sources:[cambridge('before')],note:'Cambridge US lists /bɪˈfɔːr/.'}});
  ensureSourceRecord(data,'before','/bɪˈfoʊr/',{note:'Cambridge Academic Content gives /bɪˈfoʊr/ as an alternate US pronunciation; displayed in the project IPA style.'});
  const beforeGroups=new Map();for(const record of data.before){const group=beforeGroups.get(record.ipa)||[];group.push(record);beforeGroups.set(record.ipa,group);}
  const beforeOrder=['/bɪˈfɔːr/','/bɪˈfoʊr/','/bəˈfɔːr/','/biˈfɔːr/'];data.before=[...beforeOrder.flatMap(ipa=>beforeGroups.get(ipa)||[]),...data.before.filter(record=>!beforeOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(data,'woman',{'/ˈwʊmən/':{sources:[cambridge('woman')],note:'Cambridge US lists /ˈwʊm.ən/.'}});
  annotateRecords(data,'data',{
    '/ˈdeɪtə/':{sources:[cambridge('data')],note:'Cambridge US lists /ˈdeɪ.t̬ə/; the reader convention omits the flap marker.'},
    '/ˈdætə/':{sources:[cambridge('data')],note:'Cambridge US lists /ˈdæt̬.ə/; the reader convention omits the flap marker.'}
  });
  promote(data,'fire','/faɪr/',{calibrationNote:'Cambridge US lists /faɪr/; promoted as the primary US pronunciation. The Wiktionary two-syllable candidate remains pending.'});
  promote(data,'during','/ˈdʊrɪŋ/',{calibrationNote:'Cambridge US lists /ˈdʊr.ɪŋ/; promoted as the dictionary-supported default while other CMUdict variants remain under review.'});
  promote(data,'between','/bɪˈtwiːn/',{calibrationNote:'Cambridge US lists /bɪˈtwiːn/; promoted above source-listed weak-vowel alternatives pending review.'});
  promote(data,'want','/wɑːnt/',{sourceUrl:'https://dictionary.cambridge.org/us/dictionary/english/want',calibrationNote:'Cambridge US lists /wɑːnt/ as the main form; Cambridge Academic US also gives /wɔnt/. Both are retained.'});
  annotateRecords(data,'want',{'/wɔːnt/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/want'],note:'Cambridge Academic Content lists /wɔnt/ as an American variant.'}});
  annotateRecords(data,'really',{
    '/ˈriːəli/':{sources:[cambridge('really')],note:'Cambridge US lists /ˈriː.ə.li/.'},
    '/ˈriːli/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/really'],note:'Cambridge Academic US lists /ˈriːli/ as a variant.'}
  });
  ensureSourceRecord(data,'also','/ˈɑːlsoʊ/',{note:'Cambridge Advanced US lists /ˈɑːl.soʊ/; syllable dot normalized.'});
  const alsoGroups=new Map();for(const record of data.also){const group=alsoGroups.get(record.ipa)||[];group.push(record);alsoGroups.set(record.ipa,group);}
  const alsoOrder=['/ˈɑːlsoʊ/','/ˈɔːlsoʊ/'];data.also=[...alsoOrder.flatMap(ipa=>alsoGroups.get(ipa)||[]),...data.also.filter(record=>!alsoOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(data,'also',{
    '/ˈɑːlsoʊ/':{sources:[cambridge('also')],note:'Cambridge Advanced US lists /ˈɑːl.soʊ/.'},
    '/ˈɔːlsoʊ/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/also'],note:'Cambridge Academic US lists /ˈɔl·soʊ/ in its own American transcription system; retained as a separately transcribed dictionary form.'}
  });
  ensureSourceRecord(data,'already','/ɑːlˈredi/',{note:'Cambridge Advanced US lists /ɑːlˈred.i/; syllable dot normalized.'});
  annotateRecords(data,'already',{
    '/ɑːlˈredi/':{sources:[cambridge('already')],note:'Cambridge Advanced US lists /ɑːlˈred.i/.'},
    '/ɔːlˈredi/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/already'],note:'Cambridge Academic US gives /ɔlˈred·i/ using its American transcription convention.'}
  });
  const alreadyGroups=new Map();for(const record of data.already){const group=alreadyGroups.get(record.ipa)||[];group.push(record);alreadyGroups.set(record.ipa,group);}
  const alreadyOrder=['/ɑːlˈredi/','/ɔːlˈredi/','/ɔːˈredi/'];data.already=[...alreadyOrder.flatMap(ipa=>alreadyGroups.get(ipa)||[]),...data.already.filter(record=>!alreadyOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(data,'asked',{
    '/æskt/':{sources:['https://www.oxfordlearnersdictionaries.com/definition/english/ask_1'],note:'Oxford entry lists /æskt/ for asked in the American pronunciation column.'}
  },'oxford-american-2026-09-23');
  annotateRecords(data,'against',{'/əˈɡenst/':{sources:[cambridge('against')],note:'Cambridge US lists /əˈɡenst/.'}});
  promote(data,'against','/əˈɡenst/',{calibrationNote:'Cambridge US lists /əˈɡenst/; /əˈɡeɪnst/ remains pending independent American confirmation.'});
  promote(data,'your','/jʊr/',{calibrationNote:'Cambridge Advanced US labels /jʊr/ strong and /jɚ/ weak; promoted the strong reading. Academic US also lists /jɔr/ and /jər/, which are retained.'});
  annotateRecords(data,'your',{
    '/jʊr/':{sources:[cambridge('your')],note:'Cambridge Advanced US lists /jʊr/ as the strong pronunciation.'},
    '/jər/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/your'],note:'Cambridge Advanced US lists weak /jɚ/; normalized to the project’s non-rhotic-symbol style.'},
    '/jɔːr/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/your'],note:'Cambridge Academic US lists /jɔr/ as an American form.'}
  });
  const yourGroups=new Map();for(const record of data.your){const group=yourGroups.get(record.ipa)||[];group.push(record);yourGroups.set(record.ipa,group);}
  const yourOrder=['/jʊr/','/jɔːr/','/jər/','/jɜːr/','/jɪr/'];data.your=[...yourOrder.flatMap(ipa=>yourGroups.get(ipa)||[]),...data.your.filter(record=>!yourOrder.includes(record.ipa))].map((record,index)=>({...record,rank:index+1}));
  annotateRecords(data,'their',{'/ðer/':{sources:[cambridge('their')],note:'Cambridge US lists /ðer/.'}});
  annotateRecords(data,'them',{
    '/ðem/':{sources:[cambridge('them')],note:'Cambridge US lists strong /ðem/ for the pronoun and /ðem/ for the determiner.'},
    '/ðəm/':{sources:[cambridge('them')],note:'Cambridge US lists weak /ðəm/ for the pronoun.'}
  });
  promote(data,'when','/wen/',{calibrationNote:'Cambridge Advanced US lists /wen/; Cambridge Academic US additionally records the wh-preserving /hwɛn/ variant.'});
  annotateRecords(data,'when',{
    '/wen/':{sources:[cambridge('when')],note:'Cambridge US lists /wen/.'},
    '/hwen/':{sources:['https://dictionary.cambridge.org/us/dictionary/english/when'],note:'Cambridge Academic US lists /hwɛn/; its vowel mark maps to the project’s /e/ convention.'}
  });
  calibrateHighFrequencyFunctionWords(data);
  annotateEuler(data);
  ensureProjectNoun(data);
  annotateRecords(data,'record',{
    '/ˈrekərd/':{sources:[cambridge('record')],note:'Cambridge US lists /ˈrek.ɚd/ for the noun/adjective; syllable dot normalized.'},
    '/rɪˈkɔːrd/':{sources:[cambridge('record')],note:'Cambridge US lists /rɪˈkɔːrd/ for the verb.'}
  });
  annotateRecords(data,'research',{
    '/ˈriːsɜːrtʃ/':{sources:[cambridge('research')],note:'Cambridge US lists the /ˈriː-/ stress for noun and verb.'},
    '/rɪˈsɜːrtʃ/':{sources:[cambridge('research')],note:'Cambridge US lists /rɪˈ-/ as a noun variant; American Dictionary/Academic entries also report it for verb.'}
  });
  annotateRecords(data,'use',{
    '/juːs/':{sources:[cambridge('use')],note:'Cambridge US: /juːs/ noun.'},
    '/juːz/':{sources:[cambridge('use')],note:'Cambridge US: /juːz/ verb.'}
  });
  ensureTori(data);
}
canonical.sourceAudit = {
  checkedAt:'2026-09-23',
  source:'Cambridge Dictionary US pronunciation entries',
  format:'只保留明确标出的 US 读音；显示时去除音节分隔点和排版空格，不改变音素或重音。',
  verified,
  pendingReview
};

const totalRecords = Object.values(canonical.entries).reduce((sum, list) => sum + list.length, 0);
const rows = verified.map(item => {
  const sources=item.sourceUrls || [item.sourceUrl || cambridge(item.word)];
  const links=sources.map((url,index)=>`[${item.sourceLabels?.[index] || item.sourceLabel || 'Cambridge US'}](${url})`).join(', ');
  return `| ${item.word} | \`${item.sourceIpa}\` | \`${item.readerIpa}\` | ${item.status}${item.oldIpa ? `（原值 \`${item.oldIpa}\`）` : ''} | ${links} |`;
}).join('\n');
const report = [
  '# 《三体》英语版美式音标逐词核验', '',
  '状态：进行中。本报告中的“已核验”仅指列出的词已逐条对照所引美式词典；未列词条不视为通过。', '',
  '## 审计范围', '',
  `- 本地词典词头：${Object.keys(canonical.entries).length.toLocaleString('en-US')}。`,
  `- 本地读音记录：${totalRecords.toLocaleString('en-US')}。`,
  `- 本报告列出 ${verified.length} 个有可追溯来源的词头；逐词处理方式、来源读音与阅读器读音均按条目记录。`,
  '- 核验目标：验证已有 IPA，并检查权威美式来源是否列出本地漏掉的常用读音。',
  '- AI 排序不计作词典核验；模型单独给出的音标不计作有来源支持。', '',
  '## 已核验词条', '',
  '| 词 | 来源所列 US IPA | 阅读器显示 | 处理 | 来源 |',
  '| --- | --- | --- | --- | --- |', rows, '',
  '## 本轮发现与边界', '',
  '- celestial 的旧记录 /səˈlestʃəl/ 未附权威来源；Cambridge US 给出 /sɪˈles.tʃəl/，已将显示音标修正为 /sɪˈlestʃəl/，并保留来源原式与核验日期。',
  '- Copenhagen 的 Cambridge US 标注为 /ˌkoʊ.pənˈheɪ.ɡən/，当前阅读器记录中与 /heɪ/ 对应的读音现已按其主重音、次重音顺序更正；/hɑː/ 候选仍单独保留待查。',
  '- Europe 的 Cambridge US 常见读音为 /ˈjʊr.əp/；Paris 的 Cambridge US 词条为 /ˈper.ɪs/，英式词条为 /ˈpær.ɪs/。已分别将 /ˈjʊrəp/ 与 /ˈperɪs/ 提为阅读器默认首选，其它有来源的地区变体暂保留，不因单一词典未列出就删除。',
  '- Euler 的 Cambridge US 词条列 /ˈjuːlɚ/；American Heritage、Dictionary.com 及伊利诺伊大学数学/工程院系材料支持数学语境常见的 “Oiler” /ˈɔɪlər/。两者均保留，Oiler 排首位；排序依据与权威词典分歧已明确记录，不把其伪装成无争议结论。',
  '- Jupiter 的 Cambridge US 记录为 /ˈdʒuː.pə.t̬ɚ/，即弱读 /ə/ 加美式闪音；将本地已有 /ˈdʒuːpətər/ 提为首选，并保留 /ˈdʒuːpɪtər/ 作为其它词典记录的候选。',
  '- Israel 的 Oxford NAmE 与 Collins American English 均列 /ˈɪzriəl/；Cambridge US 列 /ˈɪzreɪl/。两种都是有来源支持的美式读音，将双重词典支持形式提为首位，未删除 Cambridge 形式。',
  '- project 的 Cambridge US 分别给出名词 /ˈprɑː.dʒekt/ 与动词 /prəˈdʒekt/。补入先前缺失的名词音，并保持词性标注；同一名词下其他拼写候选暂留待审。',
  '- record 的 Cambridge US 区分名词 /ˈrek.ɚd/ 与动词 /rɪˈkɔːrd/，阅读器已有读音与“名/动”标签吻合；另一名词 IPA 留待独立来源核查。use 的 /juːs/ 名词、/juːz/ 动词也与 Cambridge 一致。',
  '- research 的 Cambridge US 收录 /ˈriː-/ 与 /rɪˈ-/ 两种重音；两种都可见于名词和动词，不给 IPA 强加词性标签。',
  '- tori 出现在几何形状并列的数学段落中，是 torus 的复数；此前词典缺少此读音，现已加入 Cambridge US 记录 /ˈtɔːraɪ/。',
  '- I’ll 的美式词典主式为 /aɪl/，Academic Content 另列 /ɑɪl/；Wiktionary 标 General American 的 /ɑːl/ 与前者并非同一种转写。该候选保留待审，不因常规词典未列出就直接删除。',
  '- again 的 Cambridge US 主读音为 /əˈɡen/；Cambridge Academic Content 另列 /əˈɡeɪn/，保留并将前者作为首选。human 的 Cambridge US 为 /ˈhjuːmən/；CMUdict 的无 /h/ 读音保留待核。',
  '- because 的 Cambridge US 把 /bɪˈkʌz/、/bɪˈkɑːz/ 列为连词读音，并将 /bɪˈkɑːz/ 用于非正式介词。/bɪˈkɔːz/ 与 /bɪkəz/ 暂不删除，等待独立美式来源核验。within 的 Cambridge US 是 /wɪˈðɪn/；Wiktionary 的 /wɪˈθɪn/ 暂留待核。',
  '- Cambridge 的音节分隔点及版面空格仅在阅读器显示时省略；不将英式记录转写成美式，也不因模型排序增加或删除读音。',
  '- specifically 等有多个候选的条目尚需逐词来源核验；未因单个来源只列一种形式就擅自删除其它候选。',
  '- 高频功能词逐项区分强读和弱读：to 新增美式 /t̬ə/、/tu/，剔除 Cambridge 仅列为 UK 的 /tʊ/；/toʊ/ 是专名 To 的读音，已限为大小写匹配。that、and、a 的强弱读均按 Cambridge US 记录，and 补入 /ən/。', '',
  '- 本轮继续补齐 can /kən/、could /kəd/、must /məst/ 与 /məs/：均为 Cambridge US 明列的弱读，置于各自强读之后；没有把未获当前美式词典证据支持的更强缩约式加入。', '',
  '- 本轮再核 will /wəl/、would /wəd/、should /ʃəd/。Cambridge US 明列相应弱读；would 的 /əd/ 仅见标注为 UK 的条目，故未加入美式数据。', '',
  '- 本轮检查 may /meɪ/、might /maɪt/、shall：Cambridge US 与 Collins 确认前两词的常规读音且所查页面未列独立弱读；shall 补入美式弱读 /ʃəl/。', '',
  '- DeepSeek-Flash 对 14 个正文高频词做了问题初筛；模型仅作线索。本轮对 be、had、he、she 的弱读线索逐项核实后补入 Cambridge US 有明确标注的候选；模型关于 but、this 等的无来源弱读猜测未采纳。', '',
  '- 新一批 DeepSeek-Flash 初筛 30 个高频词，耗用 3,517 tokens。being、doing 与 say / said / saying 的读音经 Cambridge US 或 Oxford American 来源逐项确认；says 的 /sez/ 有 Cambridge 与 Oxford 双重支持，但 CMUdict 的 /sɪz/ 未找到独立权威来源，保留在待裁列表，不擅自删掉。', '',
  '- 第二批 DeepSeek-Flash 未报告 is、are 疑点；Cambridge US 逐条复核发现词库漏了明确标注的弱读：is 新增 /əz/、/z/、/s/，are 新增 /r/ 并用项目记法 /ər/ 规范表示 Cambridge /ɚ/。这类漏读说明模型筛查之后仍必须逐项查来源。', '',
  '- 本轮再次用 DeepSeek-Flash 初筛 12 个词头（1,762 tokens），模型全部判为无疑点；Cambridge US 对照发现 an 的强读 /æn/ 应排在弱读 /ən/ 前。现已按来源纠正顺序并记录模型漏检；其余模型判断不单独作为核验结论。', '',
  '## 待裁定的来源冲突', '',
  '| 词 | 本地候选 | 权威来源证据 | 处理 |',
  '| --- | --- | --- | --- |',
  ...pendingReview.map(item => `| ${item.word} | ${item.candidates.join(' · ')} | ${item.evidence} [Cambridge](${item.sources[0]}) | 保留候选，待进一步核验 |`), '',
  '## 尚未完成', '',
  `仍有 ${(Object.keys(canonical.entries).length - verified.length).toLocaleString('en-US')} 个词头未完成最终逐词裁定（其中 ${pendingReview.length} 个来源冲突另列待裁），不能视为已通过。后续逐批记录来源、来源所列美式读音、修正与无法判定原因。`, '',
  '## 来源与方法边界', '',
  '- Cambridge 美式发音页用于逐词核对；若页面无美式标注或无法访问，该词留待复核，不从英式读音推导。',
  '- Kaikki/Wiktionary 原始记录仅在同一发音记录明确标注 US 或 General-American 时作为美式候选。',
  '- CMUdict 是美式发音词库；ARPAbet 转写及其 IPA 映射仍需按具体词逐条核验。',
  '- 原始 IPA、来源链接及本轮审核信息保存在本地数据中；此报告不代表全部词条已校准。', ''
].join('\n');

await writeFile(rawFile, `${JSON.stringify(raw)}\n`, 'utf8');
await writeFile(canonicalFile, `${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
const html = await readFile(readerFile, 'utf8');
const pattern = /(<script id="americanPronunciationData" type="application\/json">)[\s\S]*?(<\/script>)/;
if (!pattern.test(html)) throw new Error('阅读器中没有找到美式音标数据区域。');
const embedded = JSON.stringify(canonical).replace(/</g, '\\u003c');
await writeFile(readerFile, html.replace(pattern, `$1${embedded}$2`), 'utf8');
await writeFile(reportFile, report, 'utf8');
console.log(JSON.stringify({corrected:'celestial', oldIpa:'/səˈlestʃəl/', newIpa:'/sɪˈlestʃəl/', source:cambridge('celestial'), verifiedTerms:verified.length, report:reportFile}, null, 2));
