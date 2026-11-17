import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  allowedUpstreamPaths,
  CIRCUIT_RUNTIME_FILES,
  classifyDrawioPath,
  DRAWIO_POLICY,
} from "./drawio-bundle-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const drawioSessionStoreSource = (await readFile(join(ROOT, "scripts", "drawio-editor-sessions.mjs"), "utf8")).replace("export function", "function");
const OUTPUT_ROOT = join(ROOT, "resources", "drawio");
const LICENSE_ROOT = join(ROOT, "resources", "licenses", "drawio");
const LOCALIZATION_SOURCE = join(OUTPUT_ROOT, "localization", "zh-cn-overrides.txt");
const TOOL_LABELS_SOURCE = join(OUTPUT_ROOT, "localization", "tool-labels-zh.json");
export const DRAWIO_LICENSE_HASH =
  "5ad8c213095c573921d7388edf93f6a9f54490b8ebf3b165ae8ef1947cf70846";
export const DRAWIO_MODIFICATION_NOTICE =
  "Modified by 知产小栈Work: offline integration and Simplified Chinese defaults; upstream draw.io v30.0.4.";

export function markDrawioModification(text, format) {
  if (text.includes(DRAWIO_MODIFICATION_NOTICE)) return text;
  if (format === "html") {
    const notice = `<!-- ${DRAWIO_MODIFICATION_NOTICE} -->`;
    return /^<!doctype[^>]*>/iu.test(text)
      ? text.replace(/^(<!doctype[^>]*>)/iu, `$1\n${notice}`)
      : `${notice}\n${text}`;
  }
  return `${format === "properties" ? "#" : "//"} ${DRAWIO_MODIFICATION_NOTICE}\n${text}`;
}

export const PATENT_HIDDEN_MENU_ITEMS = Object.freeze([
  "editTooltip",
  "editLink",
  "openLink",
  "tags",
  "scratchpad",
  "animations",
  "diagramLanguage",
  "editDiagram",
  "plugins",
  "embed",
  "print",
]);

export const PATENT_ADVANCED_MENU_ITEMS = Object.freeze([
  "editData",
  "editStyle",
  "editGeometry",
  "editPolygon",
  "editConnectionPoints",
  "layers",
  "ruler",
  "pageScale",
  "units",
  "layout",
  "collapseExpand",
]);

export const PATENT_DEFAULT_LIBRARY_ENTRIES = "general;basic;arrows2;flowchart;er;uml";
export const PATENT_CIRCUIT_LIBRARY_ENTRIES = "electrical";

export const PATENT_HIDDEN_LIBRARY_ENTRIES = Object.freeze([
  "ios",
  "mockups",
  "active_directory",
  "atlassian",
  "salesforce",
  "alibaba_cloud",
  "allied_telesis",
  "aws3",
  "aws4b",
  "aws4",
  "aws3d",
  "azure2",
  "mscae",
  "cisco",
  "cisco19",
  "cisco_safe",
  "cumulus",
  "citrix2",
  "citrix",
  "dynamics365",
  "gcp2",
  "gcp3",
  "gcpicons",
  "ibm",
  "ibm_cloud",
  "kubernetes",
  "office",
  "openstack",
  "sap",
  "veeam2",
  "vvd",
]);

export const DRAWIO_UI_LABELS = Object.freeze({
  "AWS 2026": "亚马逊云服务 2026",
  "AWS 3D": "亚马逊云服务三维图标",
  AWS17: "亚马逊云服务 2017",
  AWS18: "亚马逊云服务 2018",
  "Active Directory": "活动目录",
  "Alibaba Cloud": "阿里云",
  "Allied Telesis": "安奈特网络",
  Android: "安卓",
  "ArchiMate 2.1": "企业架构建模 2.1",
  "ArchiMate 3.2": "企业架构建模 3.2",
  Atlassian: "协作开发工具",
  Azure: "微软云",
  "BPMN 2.0": "业务流程模型和标记法 2.0",
  Bootstrap: "网页界面组件",
  C4: "软件架构模型",
  Cisco: "思科",
  Cisco19: "思科 2019",
  "Cisco Safe": "思科安全架构",
  Citrix: "思杰",
  "Citrix (legacy)": "思杰（旧版）",
  "Cloud & Enterprise": "云与企业",
  Connector: "连接器",
  Cumulus: "累积网络",
  "Data Flow Diagram": "数据流图",
  Dynamics365: "微软商业应用 365",
  EIP: "企业集成模式",
  "Electrical / Audio": "电路 / 音频",
  "Electrical / Capacitors": "电路 / 电容器",
  "Electrical / Diodes": "电路 / 二极管",
  "Electrical / Inductors": "电路 / 电感器",
  "Electrical / Instruments": "电路 / 仪表",
  "Electrical / Logic Gates": "电路 / 逻辑门",
  "Electrical / Misc": "电路 / 杂项",
  "Electrical / Optical": "电路 / 光学器件",
  "Electrical / PLC Ladder": "电路 / 可编程控制器梯形图",
  "Electrical / Resistors": "电路 / 电阻器",
  "Electrical / Rotating Equipment & Mechanical Functions": "电路 / 旋转设备与机械功能",
  "Electrical / Sources": "电路 / 电源",
  "Electrical / Switches and Relays": "电路 / 开关与继电器",
  "Electrical / Transistors": "电路 / 晶体管",
  "Electrical / Transmission Paths": "电路 / 传输路径",
  "Electrical / Vacuum Tubes": "电路 / 真空管",
  "Electrical / Waveforms": "电路 / 波形",
  "Fluid Power (ISO 1219)": "流体动力（国际标准 1219）",
  "GCP Icons": "谷歌云图标",
  "Google Cloud Platform": "谷歌云平台",
  "Google Cloud Platform 2026": "谷歌云平台 2026",
  Helvetica: "默认字体",
  IBM: "国际商业机器公司",
  "IBM Cloud": "国际商业机器云",
  Infographic: "信息图表",
  Kubernetes: "容器编排",
  "Network 2018": "网络图标 2018",
  "Network 2025": "网络图标 2025",
  Office: "微软办公",
  OpenStack: "开放云平台",
  SAP: "企业管理系统",
  Salesforce: "客户关系管理云",
  Shape: "形状",
  SimSun: "宋体",
  Sitemap: "网站结构图",
  SysML: "系统建模语言",
  "Threat Modeling": "威胁建模",
  "Value Stream Mapping": "价值流图",
  Veeam: "备份与恢复",
  VMware: "威睿虚拟化",
  "Web Icons": "网页图标",
  "iOS Icons": "苹果移动系统图标",
  "iOS UI": "苹果移动系统界面",
  iOS: "苹果移动系统",
  iOS6: "苹果移动系统第六版",
  "自由绘图 (X)": "自由绘图",
});

export async function vendorDrawio({ sourceDirectory = process.env.DRAWIO_SOURCE_PATH } = {}) {
  const source = sourceDirectory ? resolve(sourceDirectory) : await clonePinnedUpstream();
  await verifyPinnedUpstream(source);
  await assertNoSymbolicLinks(join(source, "src", "main", "webapp"));
  await assertNoSymbolicLinks(OUTPUT_ROOT);
  const stageRoot = join(dirname(OUTPUT_ROOT), `.drawio-stage-${process.pid}`);
  const stageAppRoot = join(stageRoot, "app");
  const stageRuntimeRoot = join(stageRoot, "runtime");
  const stageTemplateRoot = join(stageRoot, "templates");
  try {
    await rm(stageRoot, { recursive: true, force: true });
    await mkdir(stageAppRoot, { recursive: true });
    await mkdir(stageRuntimeRoot, { recursive: true });
    for (const file of CIRCUIT_RUNTIME_FILES) {
      await cp(join(OUTPUT_ROOT, "runtime", file), join(stageRuntimeRoot, file));
    }
    for (const relativePath of allowedUpstreamPaths()) {
      if (classifyDrawioPath(relativePath) !== "allow") {
        throw new Error(`draw.io policy rejected configured path: ${relativePath}`);
      }
      const from = join(source, "src", "main", "webapp", relativePath);
      await stat(from);
      const to = join(stageAppRoot, relativePath);
      await mkdir(dirname(to), { recursive: true });
      await cp(from, to);
    }
    const stagedBootstrap = join(stageAppRoot, "js", "bootstrap.js");
    await writeFile(
      stagedBootstrap,
      forceSimplifiedChineseBootstrap(await readFile(stagedBootstrap, "utf8")),
      "utf8",
    );
    const stagedIndex = join(stageAppRoot, "index.html");
    await writeFile(
      stagedIndex,
      sanitizeDrawioIndexHtml(await readFile(stagedIndex, "utf8")),
      "utf8",
    );
    await writeDrawioAdapter(stageAppRoot);
    for (const runtimePath of DRAWIO_POLICY.appFiles.filter((path) =>
      path.startsWith("resources/"),
    )) {
      const stagedRuntime = join(stageAppRoot, runtimePath);
      await writeFile(
        stagedRuntime,
        sanitizeDrawioRuntime(await readFile(stagedRuntime, "utf8")),
        "utf8",
      );
    }
    const officialEnglish = await readFile(join(stageAppRoot, "resources", "dia.txt"), "utf8");
    const officialChinese = await readFile(join(stageAppRoot, "resources", "dia_zh.txt"), "utf8");
    await writeFile(
      join(stageAppRoot, "patent-localization.js"),
      buildPatentLocalizationBootstrap(
        officialEnglish,
        officialChinese,
        parseDrawioToolLabels(await readFile(TOOL_LABELS_SOURCE, "utf8")),
      ),
      "utf8",
    );
    const patentChinese = buildPatentChineseResource(
      officialChinese,
      await readFile(LOCALIZATION_SOURCE, "utf8"),
    );
    await writeFile(join(stageAppRoot, "resources", "patent_zh.txt"), patentChinese, "utf8");
    await writePatentTemplates(stageTemplateRoot);
    await cp(join(source, "LICENSE"), join(stageRoot, "LICENSE"));
    await stageLicenseMaterials(stageRoot);
    const manifest = await createManifest(stageRoot);
    await writeFile(
      join(stageRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    await publishDrawioBundle({ rootDirectory: ROOT, stageRoot });
    return manifest;
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

function parseDrawioResourceEntries(source) {
  const entries = new Map();
  for (const line of source.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    entries.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return entries;
}

export function buildDrawioTooltipLabels(officialEnglish, officialChinese) {
  const english = parseDrawioResourceEntries(officialEnglish);
  const chinese = parseDrawioResourceEntries(officialChinese);
  const candidates = new Map();
  const conflicts = new Set();
  for (const [key, englishValue] of english) {
    const chineseValue = chinese.get(key);
    if (
      !chineseValue ||
      chineseValue === englishValue ||
      PRESERVED_LOCALIZATION_TOKENS.includes(englishValue)
    ) {
      continue;
    }
    const previous = candidates.get(englishValue);
    if (previous && previous !== chineseValue) conflicts.add(englishValue);
    else candidates.set(englishValue, chineseValue);
  }
  for (const value of conflicts) candidates.delete(value);
  return Object.fromEntries([...candidates].sort(([left], [right]) => left.localeCompare(right)));
}

export function parseDrawioToolLabels(source) {
  const parsed = JSON.parse(source);
  if (parsed == null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("draw.io tool label dictionary must be an object");
  }
  const entries = Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right, "en"));
  for (const [english, chinese] of entries) {
    if (!english || typeof chinese !== "string" || !chinese.trim()) {
      throw new Error("draw.io tool label dictionary contains an empty label");
    }
    if (/\p{Script=Latin}/u.test(chinese)) {
      throw new Error(`draw.io tool label remains untranslated: ${english}`);
    }
    if (
      [...chinese].some((character) => {
        const code = character.charCodeAt(0);
        return (
          code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
        );
      })
    ) {
      throw new Error(`draw.io tool label contains a control character: ${english}`);
    }
  }
  return Object.fromEntries(entries);
}

export function buildPatentLocalizationBootstrap(
  officialEnglish = "",
  officialChinese = "",
  toolLabels = {},
) {
  const tooltipLabels = JSON.stringify(buildDrawioTooltipLabels(officialEnglish, officialChinese));
  const uiLabels = JSON.stringify({ ...toolLabels, ...DRAWIO_UI_LABELS });
  const hiddenMenuItems = JSON.stringify(PATENT_HIDDEN_MENU_ITEMS);
  const hiddenLibraryEntries = JSON.stringify(PATENT_HIDDEN_LIBRARY_ENTRIES);
  return `window.RESOURCE_BASE="resources/patent";
(()=>{
const labels=${uiLabels};
const tooltipLabels=${tooltipLabels};
const hiddenMenuItems=${hiddenMenuItems};
const hiddenLibraryEntries=new Set(${hiddenLibraryEntries});
const filterLibraries=(entries)=>typeof entries==="string"?entries.split(";").filter((entry)=>entry!==""&&!hiddenLibraryEntries.has(entry)).join(";"):entries;
const installPatentEditorPolicy=()=>{
if(typeof Menus!=="undefined"&&Array.isArray(Menus.prototype.defaultMenuItems)){
Menus.prototype.defaultMenuItems=Menus.prototype.defaultMenuItems.filter((item)=>item!=="help");
Menus.prototype.hiddenMenuItems=Object.assign({},Menus.prototype.hiddenMenuItems||{},Object.fromEntries(hiddenMenuItems.map((item)=>[item,true])));
const originalMenusInit=Menus.prototype.init;
Menus.prototype.init=function(){
originalMenusInit.apply(this,arguments);
this.put("patentAdvanced",new Menu(mxUtils.bind(this,function(menu,parent){
this.addMenuItems(menu,["editData","editStyle","editGeometry","editPolygon","editConnectionPoints","-","layers","ruler","pageScale"],parent);
this.addSubmenu("units",menu,parent);
this.addSubmenu("layout",menu,parent);
this.addMenuItems(menu,["-","collapseExpand"],parent);
})));
this.put("file",new Menu(mxUtils.bind(this,function(menu,parent){
this.addSubmenu("importFrom",menu,parent);
this.addSubmenu("exportAs",menu,parent);
this.addMenuItems(menu,["-","pageSetup"],parent);
})));
this.put("edit",new Menu(mxUtils.bind(this,function(menu,parent){
this.addMenuItems(menu,["undo","redo","-","cut","copy","copyAsImage","copyAsSvg","paste","delete","-","duplicate","-","findReplace","-","edit","-","selectVertices","selectEdges","selectAll","selectNone","-","lockUnlock"],parent);
})));
this.put("view",new Menu(mxUtils.bind(this,function(menu,parent){
this.addMenuItems(menu,["format","outline","-","search","toggleShapes","-","pageView","pageTabs","-","tooltips","-"],parent);
this.addMenuItems(menu,["grid","guides"],parent);
this.addMenuItems(menu,["-","connectionArrows","connectionPoints","-","resetView","zoomIn","zoomOut"],parent);
})));
this.put("arrange",new Menu(mxUtils.bind(this,function(menu,parent){
this.addMenuItems(menu,["toFront","toBack","bringForward","sendBackward","-"],parent);
this.addSubmenu("direction",menu,parent);
this.addMenuItems(menu,["turn","-"],parent);
this.addSubmenu("align",menu,parent);
this.addSubmenu("distribute",menu,parent);
menu.addSeparator(parent);
this.addSubmenu("navigation",menu,parent);
this.addSubmenu("insert",menu,parent);
this.addMenuItems(menu,["-","group","ungroup","removeFromGroup","-","clearWaypoints","autosize"],parent);
})));
this.put("extras",new Menu(mxUtils.bind(this,function(menu,parent){
this.addMenuItems(menu,["copyConnect","-"],parent);
this.addSubmenu("patentAdvanced",menu,parent,"高级功能");
})));
};
}
if(typeof Sidebar!=="undefined"){
Sidebar.prototype.defaultEntries="${PATENT_DEFAULT_LIBRARY_ENTRIES}";
Sidebar.prototype.configuration=Sidebar.prototype.configuration.map((entry)=>entry.id==="general"?Object.assign({},entry,{libs:["general"]}):entry);
Sidebar.prototype.configuration.push({id:"patent_extensions",libs:["misc","advanced"]});
const libraryPolicyVersion="patent-library-policy-v1";
if(typeof mxSettings!=="undefined"&&localStorage.getItem(libraryPolicyVersion)!=="1"){
mxSettings.setLibraries(Sidebar.prototype.defaultEntries);
mxSettings.save();
localStorage.setItem(libraryPolicyVersion,"1");
}
const originalUpdateEntries=Sidebar.prototype.updateEntries;
Sidebar.prototype.updateEntries=function(){
originalUpdateEntries.apply(this,arguments);
this.entries[0].entries.push({title:"杂项与高级",id:"patent_extensions"});
this.entries=this.entries.map((section)=>Object.assign({},section,{entries:section.entries.filter((entry)=>!hiddenLibraryEntries.has(entry.id))})).filter((section)=>section.entries.length>0);
};
const originalShowEntries=Sidebar.prototype.showEntries;
Sidebar.prototype.showEntries=function(entries,remember,force){
const selected=filterLibraries(entries==null&&typeof mxSettings!=="undefined"?mxSettings.getLibraries():entries)||this.defaultEntries;
const result=originalShowEntries.call(this,selected,remember,true);
this.showPalettes("",["misc","advanced"],selected.split(";").includes("patent_extensions"));
return result;
};
if(typeof mxSettings!=="undefined"&&typeof mxSettings.getLibraries==="function"){
const originalGetLibraries=mxSettings.getLibraries;
mxSettings.getLibraries=function(){return filterLibraries(originalGetLibraries.apply(this,arguments));};
}
}
if(typeof EditorUi!=="undefined"&&typeof EditorUi.prototype.showExportDialog==="function"){
const originalShowExportDialog=EditorUi.prototype.showExportDialog;
EditorUi.prototype.showExportDialog=function(){
const originalAddCheckbox=this.addCheckbox;
const exportOptionLabels=new Set([mxResources.get("grid"),mxResources.get("shadow")]);
this.addCheckbox=function(div,label,checked,disabled,disableNewline,visible,asRadio,radioGroupName,useCheckRow){
return originalAddCheckbox.call(this,div,label,checked,disabled,disableNewline,exportOptionLabels.has(label)?false:visible,asRadio,radioGroupName,useCheckRow);
};
try{return originalShowExportDialog.apply(this,arguments);}finally{this.addCheckbox=originalAddCheckbox;}
};
}
};
if(document.readyState==="loading"){window.addEventListener("load",installPatentEditorPolicy,{once:true});}else{installPatentEditorPolicy();}
const uiSelector=".geDialog,.geFormatContainer,.geMenubarContainer,.geSidebarContainer,.geTabContainer,.geToolbarContainer,.mxPopupMenu";
const setAttribute=Element.prototype.setAttribute;
const appendChild=Node.prototype.appendChild;
const localize=(value)=>/^v\\d+(?:\\.\\d+)+$/.test(value)?"版本 "+value.slice(1):(Object.prototype.hasOwnProperty.call(labels,value)?labels[value]:(Object.prototype.hasOwnProperty.call(tooltipLabels,value)?tooltipLabels[value]:value));
const localizeTooltip=(value)=>localize(value);
const localizeMoreShapesTitle=(value)=>{
const match=value.match(/^(.+) \\([^()]+\\)$/);
return match==null?localize(value):localize(match[1]);
};
const isSidebarTooltipTitle=(element)=>element instanceof HTMLElement&&element.tagName==="DIV"&&element.parentElement?.classList.contains("geSidebarTooltip");
const elementFor=(node)=>node instanceof Element?node:node.parentElement;
const isUiNode=(node)=>{
const element=elementFor(node);
return element!=null&&element.closest(uiSelector)!=null&&element.closest(".geDiagramContainer,.geItem,.gePageTab")==null;
};
const localizeUiSubtree=(node)=>{
if(!isUiNode(node)){return;}
const root=elementFor(node);
if(root==null){return;}
const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
for(let text=walker.nextNode();text!=null;text=walker.nextNode()){
if(isUiNode(text)){text.nodeValue=localize(text.nodeValue);}
}
for(const element of root.querySelectorAll("[title],[aria-label]")){
if(isUiNode(element)){
for(const name of ["title","aria-label"]){
const value=element.getAttribute(name);
if(value!=null){setAttribute.call(element,name,localize(value));}
}
}
}
};
Element.prototype.setAttribute=function(name,value){
if(name==="title"&&this.classList.contains("geMoreShapesItem")){value=localizeMoreShapesTitle(String(value));}
if(name==="title"&&isSidebarTooltipTitle(this)){
const original=String(value);
const translated=localizeTooltip(original);
if(translated!==original&&this.textContent===original){this.textContent=translated;}
value=translated;
}
if((name==="title"||name==="aria-label")&&isUiNode(this)){value=localize(value);}
return setAttribute.call(this,name,value);
};
Node.prototype.appendChild=function(node){
const result=appendChild.call(this,node);
if(isUiNode(this)||isUiNode(node)){localizeUiSubtree(node);}
return result;
};
})();
`;
}

export function sanitizeDrawioIndexHtml(html) {
  return markDrawioModification(
    html
      .replace(/\s*<meta\b[^>]*\bitemprop=["']image["'][^>]*>/giu, "")
      .replace(/\s*<link\b[^>]*\brel=["']canonical["'][^>]*>/giu, "")
      .replace(
        /\s*<link\b[^>]*\brel=["'](?:manifest|icon|shortcut icon|apple-touch-icon)["'][^>]*>/giu,
        "",
      )
      .replace(/\s*<img\b[^>]*\bsrc=["']images\/spin\.gif["'][^>]*>/giu, "")
      .replace(
        /<script src="js\/main\.js"><\/script>\r?/u,
        '<script src="patent-localization.js"></script><script src="js/main.js"></script>',
      )
      .trimStart(),
    "html",
  );
}

const FORBIDDEN_EXTERNAL_URI = /(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/[A-Za-z0-9])/u;

export const PRESERVED_LOCALIZATION_TOKENS = Object.freeze([
  "draw.io",
  "SVG",
  "PDF",
  "PNG",
  "JPEG",
  "XML",
]);

export function parseDrawioOverrides(source) {
  const entries = new Map();
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (
      [...line].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint < 32 || (codePoint >= 127 && codePoint <= 159);
      })
    ) {
      throw new Error(`draw.io override line ${index + 1} contains a control character`);
    }
    const separator = line.indexOf("=");
    if (separator < 0) throw new Error(`draw.io override line ${index + 1} is malformed`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) throw new Error(`draw.io override line ${index + 1} has an empty key`);
    if (!value) throw new Error(`draw.io override line ${index + 1} has an empty value`);
    if (entries.has(key)) throw new Error(`draw.io override contains duplicate key: ${key}`);
    const validationKey = key.normalize("NFKC");
    const validationValue = value.normalize("NFKC");
    if (
      FORBIDDEN_EXTERNAL_URI.test(validationKey) ||
      FORBIDDEN_EXTERNAL_URI.test(validationValue)
    ) {
      throw new Error(`draw.io override line ${index + 1} contains a forbidden external URI`);
    }
    entries.set(key, value);
  }
  return [...entries]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
    .concat(entries.size > 0 ? "\n" : "");
}

export function validateDrawioOverrides(source, officialChinese) {
  const normalized = parseDrawioOverrides(source);
  const officialKeys = new Set(
    officialChinese
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => line.slice(0, line.indexOf("="))),
  );
  const preservedTokens = new Set(PRESERVED_LOCALIZATION_TOKENS);
  for (const line of normalized.trimEnd().split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!officialKeys.has(key)) throw new Error(`draw.io unknown override key: ${key}`);
    for (const character of value) {
      const normalizedCharacter = character.normalize("NFKC");
      if (character !== normalizedCharacter && /\p{Script=Latin}/u.test(normalizedCharacter)) {
        throw new Error(
          `draw.io override ${key} contains unapproved Latin token: ${normalizedCharacter}`,
        );
      }
    }
    const validationValue = value.normalize("NFKC");
    for (const match of validationValue.matchAll(/[\p{Script=Latin}\p{Number}.]+/gu)) {
      const token = match[0];
      if (/\p{Script=Latin}/u.test(token) && !preservedTokens.has(token)) {
        throw new Error(`draw.io override ${key} contains unapproved Latin token: ${token}`);
      }
    }
  }
  return normalized;
}

export function buildPatentChineseResource(officialChinese, overrideSource) {
  const normalizedOfficial = officialChinese.replaceAll("\r\n", "\n");
  return `${normalizedOfficial.trimEnd()}\n${validateDrawioOverrides(overrideSource, normalizedOfficial)}`;
}

const W3C_URI_PREFIX =
  /^(?:https?:)?\/\/www\.w3\.org\/(?:1998\/Math\/MathML|2000\/svg|1999\/xhtml|1999\/xlink|TR\/SVG11\/feature#Extensibility|Graphics\/SVG\/1\.1\/DTD\/svg11\.dtd|2000\/xmlns\/)/u;

export function sanitizeDrawioRuntime(runtime) {
  return markDrawioModification(
    runtime
      .replace(/(?:https?|wss?|chrome-extension):\/\/[^\s"'<>\\]*/gu, (uri) =>
        W3C_URI_PREFIX.test(uri) ? uri : "",
      )
      .replace(/\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^\s"'<>\\]*/gu, (uri) =>
        W3C_URI_PREFIX.test(uri) ? uri : "",
      ),
    "properties",
  );
}

const DRAWIO_URL_PARAMS_SENTINEL =
  "    \r\n    return result;\r\n})();\r\n\r\n// Forces CDN caches by passing URL parameters via URL hash";

export function forceSimplifiedChineseBootstrap(runtime) {
  const occurrences = runtime.split(DRAWIO_URL_PARAMS_SENTINEL).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `draw.io bootstrap pinned URL parameter sentinel must occur exactly once; found ${occurrences}`,
    );
  }
  return markDrawioModification(
    runtime.replace(
      DRAWIO_URL_PARAMS_SENTINEL,
      '    \r\n    result.lang = "zh";\r\n    return result;\r\n})();\r\n\r\n// Forces CDN caches by passing URL parameters via URL hash',
    ),
    "js",
  );
}

export async function writeDrawioAdapter(appRoot) {
  const circuitRuntime = await Promise.all(
    CIRCUIT_RUNTIME_FILES.map(async (file) => [
      file,
      await readFile(join(dirname(appRoot), "runtime", file)),
    ]),
  );
  const index = await readFile(join(appRoot, "index.html"), "utf8");
  const embeddedIndex = index
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace("</head>", '<link rel="stylesheet" href="patent-toolbar.css"></head>')
    .replace(
      '<script src="js/bootstrap.js"></script>',
      '<script src="js/bootstrap.js"></script><script src="embed-config.js"></script>',
    )
    .replace(
      '<script src="js/main.js"></script>',
      `${CIRCUIT_RUNTIME_FILES.map((file) => `<script src="${file}"></script>`).join("")}<script src="embed-bridge.js"></script><script src="js/main.js"></script>`,
    );
  await writeFile(join(appRoot, "embed.html"), embeddedIndex, "utf8");
  for (const [file, source] of circuitRuntime) await writeFile(join(appRoot, file), source);
  await writeFile(
    join(appRoot, "embed-config.js"),
    'urlParams.lang="zh";urlParams.embed="1";urlParams.proto="json";urlParams.noSaveBtn="1";urlParams.noExitBtn="1";urlParams.libraries="0";urlParams.grid="0";urlParams.math="0";\n',
    "utf8",
  );
  await writeFile(join(appRoot, "embed-bridge.js"), DRAWIO_EMBED_BRIDGE_SOURCE, "utf8");
  await writeFile(
    join(appRoot, "patent-toolbar.css"),
    DRAWIO_PATENT_TOOLBAR_CSS + DRAWIO_CIRCUIT_TOOLBAR_CSS + DRAWIO_POPUP_SURFACE_CSS,
    "utf8",
  );
  await writeFile(
    join(appRoot, "adapter.html"),
    '<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden}</style></head><body><iframe id="editor" src="embed.html" sandbox="allow-scripts allow-same-origin" title="draw.io"></iframe><script src="adapter.js"></script></body></html>\n',
    "utf8",
  );
  await writeFile(join(appRoot, "adapter.js"), DRAWIO_ADAPTER_SOURCE, "utf8");
}

export const DRAWIO_EMBED_BRIDGE_SOURCE = `(() => {
  const adapterOrigin = "patent-diagram://editor";
  let editorUi = null;
  let sessionStore = null;
  const createSessionStore = ${drawioSessionStoreSource};
  const editorModes = new Set(["flowchart", "circuit"]);
  const modeLibraries = { flowchart: "${PATENT_DEFAULT_LIBRARY_ENTRIES}", circuit: "${PATENT_CIRCUIT_LIBRARY_ENTRIES}" };
  let editorMode = "flowchart";
  let quickWiring = null;
  let componentPolicy = null;
  let drawingTools = null;
  const toolbarActions = new Set(["toggle-project-menu", "save", "export-external", "export-to-description-drawing", "replace-description-drawing", "project-create", "project-import", "project-rename", "project-duplicate", "project-delete", "cycle-tab-next", "cycle-tab-previous"]);
  const projectFileActions = [["新建流程图", "project-create"], ["导入流程图", "project-import"], ["重命名当前流程图", "project-rename"], ["复制当前流程图", "project-duplicate"], ["删除当前流程图", "project-delete"]];
  const pendingToolbarActions = new Map();
  const toolbarActionRetryDelays = [250, 750, 1500];
  let toolbarActionSequence = 0;
  let toolbarState = { projectName: "流程图", activePageName: null, saveStatus: "loading", dirty: false, saveBusy: false, exportBusy: false, canUndo: false, canRedo: false, canReplaceDrawing: false };
  let toolbarElements = null;
  let tooltipTimer = null;
  let tooltipNode = null;
  let tooltipAnchor = null;
  const hideToolbarTooltip = () => {
    window.clearTimeout(tooltipTimer);
    if (tooltipAnchor) tooltipAnchor.removeAttribute("aria-describedby");
    if (tooltipNode) tooltipNode.remove();
    tooltipNode = null;
    tooltipAnchor = null;
  };
  const showToolbarTooltip = (anchor) => {
    hideToolbarTooltip();
    if (!anchor.isConnected || !anchor.dataset.tooltip) return;
    const tooltip = document.createElement("div");
    tooltip.className = "patent-toolbar-tooltip";
    tooltip.id = "patent-toolbar-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = anchor.dataset.tooltip;
    document.body.appendChild(tooltip);
    const control = anchor.getBoundingClientRect();
    const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = Math.max(8, Math.min(control.left, window.innerWidth - bounds.width - 8)) + "px";
    tooltip.style.top = Math.max(8, control.bottom + bounds.height + 8 <= window.innerHeight ? control.bottom + 6 : control.top - bounds.height - 6) + "px";
    anchor.setAttribute("aria-describedby", tooltip.id);
    tooltipNode = tooltip;
    tooltipAnchor = anchor;
  };
  const installToolbarTooltip = (element, label) => {
    element.dataset.tooltip = label;
    element.addEventListener("pointerenter", () => {
      hideToolbarTooltip();
      tooltipTimer = window.setTimeout(() => showToolbarTooltip(element), 500);
    });
    element.addEventListener("focus", () => showToolbarTooltip(element));
    for (const event of ["pointerleave", "blur", "click"]) element.addEventListener(event, hideToolbarTooltip);
    element.addEventListener("keydown", (event) => { if (event.key === "Escape") hideToolbarTooltip(); });
  };
  window.addEventListener("blur", hideToolbarTooltip);
  window.addEventListener("resize", hideToolbarTooltip);
  const setToolbarIcon = (button, paths) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries({viewBox:"0 0 24 24",width:"18",height:"18",fill:"none",stroke:"currentColor","stroke-width":"2","stroke-linecap":"round","stroke-linejoin":"round","aria-hidden":"true",focusable:"false"})) svg.setAttribute(name, value);
    for (const d of paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    button.replaceChildren(svg);
  };
  const createToolbarButton = (label, className, action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "patent-toolbar__button " + (className || "");
    button.textContent = label;
    button.setAttribute("aria-label", label);
    installToolbarTooltip(button, label);
    if (action) button.addEventListener("click", action);
    return button;
  };
  const emitToolbarAction = (action) => {
    if (!toolbarActions.has(action)) return;
    const graph = editorUi && editorUi.editor && editorUi.editor.graph;
    if (graph && typeof graph.stopEditing === "function") graph.stopEditing(false);
    toolbarActionSequence += 1;
    const actionId = "toolbar-" + Date.now().toString(36) + "-" + toolbarActionSequence.toString(36);
    const pending = { action, actionId, attempt: 0, timer: null };
    const send = () => {
      window.parent.postMessage(JSON.stringify({ event: "toolbar-action", action, actionId }), adapterOrigin);
      const delay = toolbarActionRetryDelays[pending.attempt];
      pending.attempt += 1;
      if (delay === undefined) { pendingToolbarActions.delete(actionId); return; }
      pending.timer = window.setTimeout(send, delay);
    };
    pendingToolbarActions.set(actionId, pending);
    send();
  };
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      emitToolbarAction(event.shiftKey ? "cycle-tab-previous" : "cycle-tab-next");
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    event.stopPropagation();
    emitToolbarAction("save");
  }, true);
  const renderEditorMode = () => {
    if (!toolbarElements) return;
    for (const [mode, button] of Object.entries(toolbarElements.modes)) {
      const active = mode === editorMode;
      button.dataset.active = String(active);
      button.setAttribute("aria-pressed", String(active));
      button.disabled = !editorUi || !editorUi.sidebar;
    }
    const circuitVisible = editorMode === "circuit" && Boolean(quickWiring && componentPolicy);
    for (const element of [toolbarElements.circuitDivider, toolbarElements.circuitTools]) {
      if (!element) continue;
      element.hidden = !circuitVisible;
      element.dataset.visible = String(circuitVisible);
    }
  };
  const applyEditorMode = (mode, report = true) => {
    if (!editorModes.has(mode) || !editorUi || !editorUi.sidebar || typeof editorUi.sidebar.showEntries !== "function") return false;
    const previousMode = editorMode;
    try {
      editorUi.sidebar.showEntries(modeLibraries[mode], false, true);
      editorMode = mode;
      if (quickWiring) quickWiring.setEditorMode(mode);
      if (componentPolicy) componentPolicy.setEditorMode(mode);
      if (drawingTools) drawingTools.applyMode(mode);
      renderEditorMode();
      if (report) window.parent.postMessage(JSON.stringify({ event: "editor-mode", mode }), adapterOrigin);
      return true;
    } catch {
      editorMode = previousMode;
      renderEditorMode();
      window.parent.postMessage(JSON.stringify({ event: "editor-mode-error", code: "LIBRARY_MODE_FAILED" }), adapterOrigin);
      return false;
    }
  };
  const renderToolbarState = () => {
    if (!toolbarElements) return;
    toolbarElements.projectName.textContent = toolbarState.projectName;
    toolbarElements.projectName.dataset.tooltip = toolbarState.projectName;
    toolbarElements.page.textContent = toolbarState.activePageName || "页面未就绪";
    const statusText = { loading: "编辑器加载中", saved: "已保存", dirty: "未保存", saving: "保存中", error: "保存失败" }[toolbarState.saveStatus] || "编辑器加载中";
    toolbarElements.status.textContent = statusText;
    toolbarElements.status.dataset.status = toolbarState.saveStatus;
    toolbarElements.undo.disabled = !toolbarState.canUndo;
    toolbarElements.redo.disabled = !toolbarState.canRedo;
    toolbarElements.save.disabled = !toolbarState.dirty || toolbarState.saveBusy;
    toolbarElements.external.disabled = toolbarState.exportBusy;
    toolbarElements.drawing.disabled = toolbarState.exportBusy;
    toolbarElements.replacement.disabled = toolbarState.exportBusy || !toolbarState.canReplaceDrawing;
  };
  const installPatentToolbar = (ui) => {
    const fileMenu = ui.menus && ui.menus.get("file");
    if (fileMenu && typeof fileMenu.funct === "function" && !fileMenu.patentProjectActions) {
      const originalFileMenu = fileMenu.funct;
      fileMenu.funct = function (menu, parent) {
        for (const [label, action] of projectFileActions) menu.addItem(label, null, () => emitToolbarAction(action), parent);
        menu.addSeparator(parent);
        return originalFileMenu.apply(this, arguments);
      };
      fileMenu.patentProjectActions = true;
    }
    const menubar = document.querySelector(".geMenubarContainer");
    if (!menubar || menubar.classList.contains("patent-toolbar")) return;
    const nativeMenus = Array.from(menubar.children);
    menubar.classList.add("patent-toolbar");
    menubar.setAttribute("role", "toolbar");
    menubar.setAttribute("aria-label", "流程图工具栏");
    const project = document.createElement("div"); project.className = "patent-toolbar__project";
    const list = createToolbarButton("工程列表", "patent-toolbar__icon", () => emitToolbarAction("toggle-project-menu")); list.textContent = "☰";
    const projectName = document.createElement("strong"); projectName.className = "patent-toolbar__project-name";
    installToolbarTooltip(projectName, toolbarState.projectName);
    const page = document.createElement("span"); page.className = "patent-toolbar__page";
    project.append(list, projectName, page);
    const dividerLeft = document.createElement("span"); dividerLeft.className = "patent-toolbar__divider";
    const modeSwitch = document.createElement("div"); modeSwitch.className = "patent-toolbar__mode-switch"; modeSwitch.setAttribute("role", "group"); modeSwitch.setAttribute("aria-label", "绘图模式");
    const flowchartMode = createToolbarButton("流程图", "patent-toolbar__mode", () => applyEditorMode("flowchart"));
    const circuitMode = createToolbarButton("电路图", "patent-toolbar__mode", () => applyEditorMode("circuit"));
    modeSwitch.append(flowchartMode, circuitMode);
    const dividerMode = document.createElement("span"); dividerMode.className = "patent-toolbar__divider";
    const menus = document.createElement("div"); menus.className = "patent-toolbar__menus"; menus.append(...nativeMenus);
    const editorToolbar = document.querySelector(".geToolbarContainer");
    const freehandButton = Array.from(editorToolbar ? editorToolbar.querySelectorAll("[title],[aria-label]") : []).find((element) => ((element.getAttribute("title") || element.getAttribute("aria-label") || "").startsWith("自由绘图")));
    const dividerRight = document.createElement("span"); dividerRight.className = "patent-toolbar__divider patent-toolbar__circuit-divider"; dividerRight.hidden = true; dividerRight.dataset.visible = "false";
    const circuitTools = document.createElement("div"); circuitTools.className = "patent-toolbar__circuit-tools"; circuitTools.hidden = true; circuitTools.setAttribute("role", "group"); circuitTools.setAttribute("aria-label", "电路工具");
    const circuitLabel = document.createElement("span"); circuitLabel.className = "patent-toolbar__circuit-label"; circuitLabel.textContent = "电路工具";
    const wiringStatus = document.createElement("span"); wiringStatus.className = "patent-toolbar__circuit-status"; wiringStatus.setAttribute("aria-live", "polite");
    const quickWiringButton = createToolbarButton("快捷连线", "patent-toolbar__quick-wiring", () => { if (!quickWiring) return; if (quickWiring.isActive()) quickWiring.disable(); else quickWiring.enable(); }); quickWiringButton.setAttribute("aria-pressed", "false");
    circuitTools.append(circuitLabel, quickWiringButton, wiringStatus);
    if (freehandButton) freehandButton.after(dividerRight, circuitTools);
    else if (editorToolbar) editorToolbar.append(dividerRight, circuitTools);
    const actions = document.createElement("div"); actions.className = "patent-toolbar__actions";
    const status = document.createElement("span"); status.className = "patent-toolbar__status"; status.setAttribute("aria-live", "polite");
    const undo = createToolbarButton("撤销", "patent-toolbar__icon", () => { const item = ui.actions.get("undo"); if (item && item.funct && (!item.isEnabled || item.isEnabled())) item.funct(); }); setToolbarIcon(undo, ["M9 14 4 9l5-5", "M4 9h10a6 6 0 0 1 0 12h-2"]); undo.dataset.tooltip = "撤销 (" + (typeof mxClient !== "undefined" && mxClient.IS_MAC ? "⌘Z" : "Ctrl+Z") + ")";
    const redo = createToolbarButton("重做", "patent-toolbar__icon", () => { const item = ui.actions.get("redo"); if (item && item.funct && (!item.isEnabled || item.isEnabled())) item.funct(); }); setToolbarIcon(redo, ["m15 14 5-5-5-5", "M20 9H10a6 6 0 0 0 0 12h2"]); redo.dataset.tooltip = "重做 (" + (typeof mxClient !== "undefined" && mxClient.IS_MAC ? "⌘⇧Z" : "Ctrl+Y") + ")";
    const save = createToolbarButton("保存", "patent-toolbar__save", () => emitToolbarAction("save"));
    const external = createToolbarButton("导出至电脑", "patent-toolbar__export-computer", () => emitToolbarAction("export-external"));
    const replacement = createToolbarButton("替换附图", "", () => emitToolbarAction("replace-description-drawing"));
    const drawing = createToolbarButton("插入附图", "patent-toolbar__button--primary", () => emitToolbarAction("export-to-description-drawing"));
    actions.append(status, undo, redo, save, external, replacement, drawing); menubar.append(project, dividerLeft, modeSwitch, dividerMode, menus, actions);
    toolbarElements = { projectName, page, status, undo, redo, save, external, replacement, drawing, circuitDivider: dividerRight, circuitTools, quickWiringButton, wiringStatus, modes: { flowchart: flowchartMode, circuit: circuitMode } };
    renderToolbarState();
    renderEditorMode();
  };
  const installBridge = () => {
    if (typeof EditorUi !== "function" || typeof EditorUi.prototype.init !== "function") return false;
    if (typeof EditorUi.prototype.isPageInsertTabVisible === "function") {
      EditorUi.prototype.isPageInsertTabVisible = () => false;
    }
    const originalInit = EditorUi.prototype.init;
    EditorUi.prototype.init = function () {
      const result = originalInit.apply(this, arguments);
      // Restrict user commands, not insertPage itself: loading, restoring and
      // deleting the last page also rely on the underlying page machinery.
      for (const name of ["insertPage", "duplicatePage"]) {
        const action = this.actions.get(name);
        if (action && typeof action.setEnabled === "function") {
          action.setVisible(false);
          action.setEnabled(false);
          action.isEnabled = () => false;
          action.funct = () => {};
        }
      }
      editorUi = this;
      sessionStore = createSessionStore(this);
      installPatentToolbar(this);
      if (drawingTools) drawingTools.dispose();
      drawingTools = null;
      if (quickWiring) quickWiring.dispose();
      if (componentPolicy) componentPolicy.dispose();
      quickWiring = null;
      componentPolicy = null;
      try {
        quickWiring = PatentCircuitQuickWiring.install({ editorUi: this, document, window, onStatus: (message, status) => { if (!toolbarElements) return; toolbarElements.wiringStatus.textContent = message; toolbarElements.wiringStatus.dataset.status = status; }, onActiveChange: (active) => { if (toolbarElements) toolbarElements.quickWiringButton.setAttribute("aria-pressed", String(active)); } });
        componentPolicy = PatentCircuitComponentPolicy.install({ editorUi: this });
        if (typeof PatentDrawingTools !== "undefined") drawingTools = PatentDrawingTools.install({editorUi:this,document,window});
      } catch {
        if (toolbarElements) toolbarElements.circuitTools.hidden = true;
        window.parent.postMessage(JSON.stringify({ event: "editor-mode-error", code: "LIBRARY_MODE_FAILED" }), adapterOrigin);
      }
      applyEditorMode("flowchart");
      const graph = this.editor && this.editor.graph;
      const reportHistory = () => {
        const canUndo = Boolean(graph.isEnabled() && this.canUndo());
        const canRedo = Boolean(graph.isEnabled() && this.canRedo());
        window.parent.postMessage(JSON.stringify({ event: "history-state", canUndo, canRedo }), adapterOrigin);
      };
      // Model CHANGE fires before its edit is added to the undo manager. Read
      // after the actual history mutation, including clear and redo-only changes.
      const manager = this.editor.undoManager;
      for (const event of [mxEvent.ADD, mxEvent.UNDO, mxEvent.REDO, mxEvent.CLEAR])
        manager.addListener(event, reportHistory);
      graph.addListener(mxEvent.EDITING_STARTED, reportHistory);
      graph.addListener(mxEvent.EDITING_STOPPED, reportHistory);
      if (graph && graph.getSelectionModel && graph.getSelectionCount) {
        const reportSelection = () => {
          const selectedCellIds = graph.getSelectionCells().map((cell) => String(cell.id)).filter((id) => id.length > 0 && id.length <= 500).slice(0, 50000);
          window.parent.postMessage(JSON.stringify({ event: "selection", selectionCount: selectedCellIds.length, selectedCellIds }), adapterOrigin);
        };
        graph.getSelectionModel().addListener(mxEvent.CHANGE, reportSelection);
        reportSelection();
      }
      reportHistory();
      const reportPages = () => {
        const editorPages = Array.isArray(this.pages) ? this.pages.slice(0, 100) : [];
        const reportedPages = editorPages.map((page, index) => ({
          id: String(page && page.getId ? page.getId() : "page-" + index),
          name: String((page && page.getName ? page.getName() : null) || "第" + (index + 1) + "页"),
        }));
        const activePageId = this.currentPage && this.currentPage.getId ? String(this.currentPage.getId()) : null;
        window.parent.postMessage(JSON.stringify({ event: "pages", pages: reportedPages, activePageId }), adapterOrigin);
      };
      this.editor.addListener("pageSelected", reportPages);
      this.editor.addListener("pageRenamed", reportPages);
      this.editor.addListener("pageMoved", reportPages);
      this.editor.addListener("pagesPatched", reportPages);
      this.editor.addListener("fileLoaded", reportPages);
      return result;
    };
    return true;
  };
  if (!installBridge()) window.addEventListener("load", installBridge, { once: true });
  window.addEventListener("beforeunload", () => { hideToolbarTooltip(); window.removeEventListener("blur", hideToolbarTooltip); window.removeEventListener("resize", hideToolbarTooltip); for (const pending of pendingToolbarActions.values()) window.clearTimeout(pending.timer); pendingToolbarActions.clear(); if (drawingTools) drawingTools.dispose(); if (quickWiring) quickWiring.dispose(); if (componentPolicy) componentPolicy.dispose(); drawingTools = null; quickWiring = null; componentPolicy = null; });
  const exportSelectionSource = () => {
    const graph = editorUi && editorUi.editor && editorUi.editor.graph;
    let cells = graph && graph.getSelectionCells ? graph.getSelectionCells() : [];
    const parent = window.parent;
    const sendExport = (payload) => parent.postMessage(JSON.stringify({ event: "export", format: "xml", ...payload }), adapterOrigin);
    if (!graph || cells.length === 0) { sendExport({}); return; }
    try {
      const codec = new mxCodec(mxUtils.createXmlDocument());
      codec.isObjectIgnored = (value) => value.constructor === mxCell && !graph.model.isRoot(value) && !graph.model.isLayer(value) && !graph.isCellSelected(value) && !graph.isAncestorSelected(value);
      const model = codec.encode(graph.getModel());
      model.ownerDocument.appendChild(model);
      sendExport({ xml: mxUtils.getXml(model) });
    } catch { sendExport({}); }
  };
  const removeUnsafeSvgTextContainers = (svgRoot) => {
    const warningLinks = Array.from(svgRoot.getElementsByTagName("a"));
    for (const link of warningLinks) {
      const href = link.getAttribute("href") || link.getAttribute("xlink:href");
      if (href === Graph.foreignObjectWarningLink && link.parentNode) link.parentNode.removeChild(link);
    }
    // Never silently discard labels when the engine cannot convert their rich text.
    if (svgRoot.getElementsByTagName("foreignObject").length > 0) return false;
    for (const link of Array.from(svgRoot.getElementsByTagName("a"))) {
      const replacement = svgRoot.ownerDocument.createElementNS(mxConstants.NS_SVG, "g");
      while (link.firstChild) replacement.appendChild(link.firstChild);
      link.parentNode?.replaceChild(replacement, link);
    }
    for (const choice of Array.from(svgRoot.getElementsByTagName("switch"))) {
      const replacement = svgRoot.ownerDocument.createElementNS(mxConstants.NS_SVG, "g");
      while (choice.firstChild) replacement.appendChild(choice.firstChild);
      choice.parentNode?.replaceChild(replacement, choice);
    }
    for (const element of Array.from(svgRoot.getElementsByTagName("*"))) {
      element.removeAttribute("requiredFeatures");
    }
    return svgRoot.getElementsByTagName("foreignObject").length === 0 && svgRoot.getElementsByTagName("switch").length === 0 && svgRoot.getElementsByTagName("a").length === 0;
  };
  const exportPatentSvg = async (selectionOnly, allPages = false, pageId, selectedCellIds) => {
    const graph = editorUi && editorUi.editor && editorUi.editor.graph;
    let cells = graph && graph.getSelectionCells ? graph.getSelectionCells() : [];
    const parent = window.parent;
    const sendExport = (payload) => parent.postMessage(JSON.stringify({ event: "export", format: "svg", ...payload }), adapterOrigin);
    if (!graph) { sendExport({}); return; }
    if (pageId !== undefined) {
      const pages = Array.isArray(editorUi.pages) ? editorUi.pages : [];
      let page = pages.find(candidate => candidate && candidate.getId && String(candidate.getId()) === pageId);
      if (!page && /^page-[0-9]+$/.test(pageId)) page = pages[Number(pageId.slice(5))];
      if (!page) { sendExport({}); return; }
      editorUi.selectPage(page);
    }
    if (selectedCellIds !== undefined) {
      cells = selectedCellIds.map(id => graph.getModel().getCell(id));
      if (!selectionOnly || allPages || new Set(selectedCellIds).size !== selectedCellIds.length || cells.some(cell => !cell || (!cell.vertex && !cell.edge))) { sendExport({}); return; }
      graph.setSelectionCells(cells);
    }
    if (selectionOnly && cells.length === 0) { sendExport({}); return; }
    const originalCreateSvgCanvas = graph.createSvgCanvas;
    const originalPage = editorUi.currentPage;
    const output = [];
    try {
      graph.createSvgCanvas = function () {
        const canvas = originalCreateSvgCanvas.apply(this, arguments);
        canvas.allowConvertHtmlToSvg = true;
        // mxText.configureCanvas resets this flag from each cell's style. Export must
        // retain conversion even for ordinary editable HTML labels, without editing cells.
        Object.defineProperty(canvas, "allowConvertHtmlToSvg", { get: () => true, set: () => {} });
        return canvas;
      };
      const targets = allPages && editorUi.pages && editorUi.pages.length ? editorUi.pages.slice() : [null];
      for (const target of targets) {
      if (target && target !== editorUi.currentPage) editorUi.selectPage(target);
      const background = graph.background === mxConstants.NONE ? null : graph.background;
      const svgRoot = graph.getSvg(background, 1, 0, false, true, !selectionOnly, true, null, null, graph.shadowVisible, null, "auto", selectionOnly ? "selectionOnly" : "diagram", selectionOnly ? cells : null, null, true);
      if (!removeUnsafeSvgTextContainers(svgRoot)) { sendExport({}); return; }
      const data = await new Promise(resolve => editorUi.editor.convertImages(svgRoot, convertedSvg => resolve(Editor.createSvgDataUri(mxUtils.getXml(convertedSvg)))));
      output.push(data);
      }
      sendExport({ data: allPages ? JSON.stringify(output) : output[0] });
    } catch { sendExport({}); }
    finally {
      graph.createSvgCanvas = originalCreateSvgCanvas;
      if (originalPage && editorUi.currentPage !== originalPage) editorUi.selectPage(originalPage);
      if (allPages && graph.setSelectionCells) graph.setSelectionCells(cells);
    }
  };
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== adapterOrigin || typeof event.data !== "string") return;
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message.action !== "string") return;
    if (message.action === "patent-toolbar-action-ack") {
      if (Object.keys(message).length !== 2 || typeof message.actionId !== "string") return;
      const pending = pendingToolbarActions.get(message.actionId);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      pendingToolbarActions.delete(message.actionId);
      return;
    }
    if (!editorUi) return;
    if (message.action === "patent-preserve-editing") {
      sessionStore.preserveEditing();
      return;
    }
    if (message.action === "patent-release-session") {
      if (typeof message.sessionId === "string") sessionStore.drop(message.sessionId);
      return;
    }
    if (message.action === "patent-activate-session") {
      if (typeof message.sessionId !== "string") return;
      hideToolbarTooltip();
      for (const pending of pendingToolbarActions.values()) window.clearTimeout(pending.timer);
      pendingToolbarActions.clear();
      editorUi.hideCurrentMenu();
      const graph = editorUi.editor.graph;
      graph.popupMenuHandler.hideMenu();
      graph.stopEditing(false);
      try {
        const restored = sessionStore.activate(message.sessionId);
        const manager = editorUi.editor.undoManager;
        window.parent.postMessage(JSON.stringify({
          event: "session-activated", sessionId: message.sessionId, restored,
          pages: restored ? editorUi.pages.map(page => ({ id: String(page.getId()), name: page.getName() })) : [],
          activePageId: restored ? String(editorUi.currentPage.getId()) : null,
          canUndo: restored && manager.canUndo(), canRedo: restored && manager.canRedo(),
          selectedCellIds: restored ? graph.getSelectionCells().map(cell => String(cell.id)) : [],
        }), adapterOrigin);
      } catch (error) {
        console.error("Flowchart session restore failed", error);
        window.parent.postMessage(JSON.stringify({event:"session-error",sessionId:message.sessionId}), adapterOrigin);
      }
      return;
    }
    if (message.action === "patent-finish-editing") {
      if (Object.keys(message).length !== 1) return;
      editorUi.editor.graph.stopEditing(false);
      return;
    }
    if (message.action === "patent-export-selection") {
      if (Object.keys(message).length !== 2 || message.format !== "xml") return;
      exportSelectionSource();
      return;
    }
    if (message.action === "patent-export-svg") {
      if (Object.keys(message).some(key => !["action", "selectionOnly", "allPages", "pageId", "selectedCellIds"].includes(key)) || typeof message.selectionOnly !== "boolean" || (message.allPages !== undefined && typeof message.allPages !== "boolean")) return;
      if (message.pageId !== undefined && (typeof message.pageId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(message.pageId))) return;
      if (message.selectedCellIds !== undefined && (!Array.isArray(message.selectedCellIds) || message.selectedCellIds.length < 1 || message.selectedCellIds.length > 50000 || message.selectedCellIds.some(id => typeof id !== "string" || id.length < 1 || id.length > 500))) return;
      exportPatentSvg(message.selectionOnly, message.allPages === true, message.pageId, message.selectedCellIds);
      return;
    }
    if (message.action === "patent-command") {
      if (Object.keys(message).length !== 2 || !["undo", "redo"].includes(message.command)) return;
      const action = editorUi.actions.get(message.command);
      if (action && action.funct && (!action.isEnabled || action.isEnabled())) action.funct();
      return;
    }
    if (message.action === "patent-toolbar-state" && Object.keys(message).length === 2 && message.state && typeof message.state === "object") {
      toolbarState = message.state; renderToolbarState(); return;
    }
    if (message.action === "patent-set-editor-mode") {
      if (Object.keys(message).length !== 2 || !editorModes.has(message.mode)) return;
      applyEditorMode(message.mode);
      return;
    }
    if (message.action !== "patent-set-page" || Object.keys(message).length !== 2 || typeof message.pageId !== "string") return;
    let page = Array.isArray(editorUi.pages) ? editorUi.pages.find((candidate) => candidate && candidate.getId && String(candidate.getId()) === message.pageId) : null;
    const syntheticPage = message.pageId.match(/^page-(\\d+)$/);
    if (!page && syntheticPage && Array.isArray(editorUi.pages)) page = editorUi.pages[Number(syntheticPage[1])] || null;
    if (page) editorUi.selectPage(page);
  });
})();
`;

export const DRAWIO_PATENT_TOOLBAR_CSS = `.geMenubarContainer.patent-toolbar{box-sizing:border-box;display:flex!important;align-items:center;flex-wrap:nowrap!important;gap:8px;height:48px!important;padding:0 12px!important;overflow:visible;white-space:nowrap;background:#fff;border-bottom:1px solid #dce3ee}.patent-toolbar__project,.patent-toolbar__actions,.patent-toolbar__circuit-tools{display:flex;align-items:center;gap:6px;min-width:0}.patent-toolbar__circuit-tools[hidden]{display:none!important}.patent-toolbar__circuit-label,.patent-toolbar__circuit-status{font-size:12px;color:#64748b}.patent-toolbar__circuit-status{max-width:150px;overflow:hidden;text-overflow:ellipsis}.patent-toolbar__circuit-status[data-status=error]{color:#c12626}.patent-toolbar__quick-wiring[aria-pressed=true]{border-color:#2563eb;background:#dbeafe;color:#1d4ed8}.patent-circuit-quick-wiring-ports{z-index:20}.patent-circuit-quick-wiring-port{width:14px;height:14px;margin:-7px 0 0 -7px;padding:0;border:2px solid #fff;border-radius:50%;background:#2563eb;box-shadow:0 0 0 1px #1d4ed8;cursor:crosshair}.patent-circuit-quick-wiring-port:focus-visible{outline:2px solid #f59e0b;outline-offset:2px}.patent-toolbar__project-name{max-width:220px;overflow:hidden;text-overflow:ellipsis;font-weight:650;color:#172033}.patent-toolbar__page{padding:4px 9px;border-radius:999px;background:#eef3fb;color:#46556d;font-size:12px}.patent-toolbar__mode-switch{display:flex;align-items:center;padding:2px;border:1px solid #d7dee9;border-radius:10px;background:#f1f5f9}.patent-toolbar__mode{height:28px;border:0;border-radius:8px;background:transparent;color:#46556d;padding:0 11px}.patent-toolbar__mode[data-active=true]{background:#fff;color:#1d4ed8;box-shadow:0 1px 3px rgba(15,23,42,.12);font-weight:650}.patent-toolbar__mode:disabled{cursor:not-allowed;opacity:.5}.patent-toolbar__menus{display:flex;align-items:center;min-width:0;overflow-x:auto;scrollbar-width:none}.patent-toolbar__menus::-webkit-scrollbar{display:none}.patent-toolbar__menus>.geMenubar{position:static!important;display:flex!important;align-items:center;height:32px!important;padding:0!important}.patent-toolbar__menus>.geMenubar>.geItem{position:static!important;display:inline-flex!important;align-items:center;height:32px!important;margin:0!important;padding:0 8px!important}.patent-toolbar .geStatus{display:none!important}.patent-toolbar__divider{width:1px;height:22px;flex:0 0 1px;background:#d7dee9}.patent-toolbar__actions{position:relative;margin-left:auto}.patent-toolbar__status{font-size:12px;color:#64748b}.patent-toolbar__status[data-status=saved]{color:#16803c}.patent-toolbar__status[data-status=error]{color:#c12626}.patent-toolbar__button{box-sizing:border-box;height:32px;border:1px solid #d7dee9;border-radius:8px;padding:0 10px;background:#f8fafc;color:#243047;font:inherit;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s}.patent-toolbar__button:hover:not(:disabled){background:#eef3fb;border-color:#b9c6d8}.patent-toolbar__button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}.patent-toolbar__button:disabled{cursor:not-allowed;opacity:.45}.patent-toolbar__icon{width:32px;padding:0;font-size:18px}.patent-toolbar__export-computer{background:#fff}.patent-toolbar__button--primary{border-color:#2563eb;background:#2563eb;color:#fff}.patent-toolbar__button--primary:hover:not(:disabled){background:#1d4ed8;border-color:#1d4ed8}@media(max-width:1040px){.patent-toolbar__project-name{max-width:120px}.patent-toolbar__actions{gap:4px}}@media(max-width:860px){.patent-toolbar__project-name{max-width:72px}.patent-toolbar__status{max-width:48px;overflow:hidden}.patent-toolbar__save{width:32px;padding:0;font-size:0}.patent-toolbar__save:before{content:"💾";font-size:15px}}\n.patent-toolbar__icon svg{vertical-align:middle;pointer-events:none}.patent-toolbar-tooltip{box-sizing:border-box;position:fixed;z-index:10000;inset:auto;width:max-content;height:auto;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:hidden;white-space:normal;overflow-wrap:anywhere;padding:6px 9px;border:1px solid #d7dee9;border-radius:6px;background:#fff;color:#243047;box-shadow:0 2px 8px #0002;font:12px/1.4 Arial,sans-serif;pointer-events:none}\n`;

export const DRAWIO_CIRCUIT_TOOLBAR_CSS = `.geToolbarContainer .patent-toolbar__circuit-divider{display:inline-block;vertical-align:middle;margin:0 5px}.geToolbarContainer .patent-toolbar__circuit-tools{display:inline-flex;align-items:center;gap:6px;vertical-align:middle}.patent-toolbar__button.patent-toolbar__quick-wiring{height:24px;padding:0 8px;font-size:12px;font-weight:700}\n`;

export const DRAWIO_POPUP_SURFACE_CSS = `html body.geEditor div.mxPopupMenu {
  box-shadow: var(--workbench-menu-shadow) !important;
}
html body.geEditor table.mxPopupMenu {
  box-shadow: none !important;
}
`;

export const DRAWIO_ADAPTER_SOURCE = `(() => {
  const installedParentOrigin = "patent-app://app";
  const isAllowedParentOrigin = (origin) => {
    if (origin === installedParentOrigin) return true;
    try {
      const candidate = new URL(origin);
      return candidate.origin === origin && candidate.protocol === "http:" && ["localhost", "127.0.0.1"].includes(candidate.hostname);
    } catch { return false; }
  };
  let parentOrigin = null;
  const editorOrigin = "patent-diagram://editor";
  const editor = document.getElementById("editor");
  const maxMessageBytes = 40 * 1024 * 1024;
  const maxSourceBytes = 20 * 1024 * 1024;
  let context = null;
  let ready = false;
  let documentLoaded = false;
  let activating = null;
  let deferredMode = null;
  let activeExport = null;
  let pages = [];
  let activePageId = null;
  const pendingRaw = [];
  const exportQueue = [];
  const bytes = (value) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
  const id = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
  const validEnvelope = (value) => value && typeof value === "object" && id(value.sessionId) && id(value.projectId) && Number.isInteger(value.projectRevision) && value.projectRevision >= 0 && id(value.requestId);
  const exact = (value, keys) => Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
  const exportFormats = ["drawio", "svg", "png", "jpeg", "pdf"];
  const toolbarActions = ["toggle-project-menu", "save", "export-external", "export-to-description-drawing", "replace-description-drawing", "project-create", "project-import", "project-rename", "project-duplicate", "project-delete", "cycle-tab-next", "cycle-tab-previous"];
  const validPagesMessage = (message) => Array.isArray(message.pages) && message.pages.length <= 100 && message.pages.every((page) => page && exact(page, ["id", "name"]) && id(page.id) && typeof page.name === "string" && page.name.length >= 1 && page.name.length <= 512) && (message.activePageId === null || id(message.activePageId));
  let reducedMotion = false;
  const applyMotionPreference = () => {
    const apply = (doc) => {
      if (!doc?.documentElement) return;
      doc.documentElement.dataset.reducedMotion = String(reducedMotion);
      let style = doc.getElementById("patent-motion-policy");
      if (!style) { style = doc.createElement("style"); style.id = "patent-motion-policy"; doc.head.append(style); }
      style.textContent = reducedMotion ? "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}" : "";
      if (reducedMotion) {
        for (const animation of doc.getAnimations?.() ?? []) {
          if (["finished", "idle"].includes(animation.playState)) continue;
          try { animation.finish(); } catch { animation.cancel(); }
        }
      }
    };
    apply(document);
    try { apply(editor.contentDocument); } catch { /* The embedded editor must share the local diagram origin. */ }
  };
  editor.addEventListener?.("load", applyMotionPreference);
  const validCommand = (message) => {
    if (!validEnvelope(message) || typeof message.type !== "string") return false;
    if (message.type === "motion-preference") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "reducedMotion"]) && typeof message.reducedMotion === "boolean";
    if (message.type === "configure") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "locale", "policy"]) && ["zh_CN", "en"].includes(message.locale) && message.policy && exact(message.policy, ["cloud", "templates", "help", "updates", "plugins", "grid", "shadow"]) && Object.values(message.policy).every((value) => value === false);
    if (message.type === "load") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "source"]) && typeof message.source === "string" && bytes(message.source) <= maxSourceBytes;
    if (message.type === "activate-session") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "source"]) && typeof message.source === "string" && bytes(message.source) <= maxSourceBytes;
    if (message.type === "request-save") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", ...(message.finishEditing === undefined ? [] : ["finishEditing"]), ...(message.preserveEditing === undefined ? [] : ["preserveEditing"])]) && (message.finishEditing === undefined || typeof message.finishEditing === "boolean") && (message.preserveEditing === undefined || typeof message.preserveEditing === "boolean");
    if (message.type === "dispose" || ["undo", "redo"].includes(message.type)) return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type"]);
    if (message.type === "toolbar-action-ack") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "actionId"]) && id(message.actionId);
    if (message.type === "request-export") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "format", "selectionOnly", ...(message.allPages === undefined ? [] : ["allPages"]), ...(message.pageId === undefined ? [] : ["pageId"]), ...(message.selectedCellIds === undefined ? [] : ["selectedCellIds"])]) && (message.pageId === undefined || id(message.pageId)) && (message.selectedCellIds === undefined || (message.format === "svg" && message.selectionOnly && !message.allPages && Array.isArray(message.selectedCellIds) && message.selectedCellIds.length > 0 && message.selectedCellIds.length <= 50000 && message.selectedCellIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 500))) && exportFormats.includes(message.format) && typeof message.selectionOnly === "boolean" && (message.allPages === undefined || typeof message.allPages === "boolean");
    if (message.type === "set-editor-mode") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "mode"]) && ["flowchart", "circuit"].includes(message.mode);
    if (message.type === "toolbar-state") return exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "projectName", "activePageName", "saveStatus", "dirty", "saveBusy", "exportBusy", "canUndo", "canRedo", ...(message.canReplaceDrawing === undefined ? [] : ["canReplaceDrawing"])]) && (message.canReplaceDrawing === undefined || typeof message.canReplaceDrawing === "boolean") && typeof message.projectName === "string" && message.projectName.length > 0 && message.projectName.length <= 512 && (message.activePageName === null || (typeof message.activePageName === "string" && message.activePageName.length > 0 && message.activePageName.length <= 512)) && ["loading", "saved", "dirty", "saving", "error"].includes(message.saveStatus) && [message.dirty, message.saveBusy, message.exportBusy, message.canUndo, message.canRedo].every((value) => typeof value === "boolean");
    return message.type === "set-page" && exact(message, ["sessionId", "projectId", "projectRevision", "requestId", "type", "pageId"]) && id(message.pageId);
  };
  const sameContext = (message) => !context || (message.sessionId === context.sessionId && message.projectId === context.projectId && message.projectRevision === context.projectRevision);
  const send = (type, payload = {}) => {
    if (!context || !parentOrigin) return;
    const message = { ...context, requestId: context.requestId, type, ...payload };
    if (bytes(message) <= maxMessageBytes) window.parent.postMessage(message, parentOrigin);
  };
  const raw = (message) => {
    if (!ready) { pendingRaw.push(message); return; }
    editor.contentWindow?.postMessage(JSON.stringify(message), editorOrigin);
  };
  const pumpExport = () => {
    if (!ready || activeExport || exportQueue.length === 0) return;
    activeExport = exportQueue.shift();
    if (activeExport.preserveEditing) raw({action:"patent-preserve-editing"});
    if (activeExport.finishEditing !== false) raw({ action: "patent-finish-editing" });
    if (activeExport.kind === "save") raw({ action: "export", format: "xml" });
    else if (activeExport.format !== "drawio") raw({ action: "patent-export-svg", selectionOnly: activeExport.selectionOnly, ...(activeExport.allPages ? {allPages: true} : {}), ...(activeExport.pageId === undefined ? {} : {pageId: activeExport.pageId}), ...(activeExport.selectedCellIds === undefined ? {} : {selectedCellIds: activeExport.selectedCellIds}) });
    else if (activeExport.selectionOnly) raw({ action: "patent-export-selection", format: "xml" });
    else raw({ action: "export", format: "xml" });
  };
  const enqueueExport = (request) => { exportQueue.push(request); pumpExport(); };
  const parsePages = (xml) => {
    try {
      const documents = new DOMParser().parseFromString(xml, "text/xml").querySelectorAll("mxfile > diagram");
      return Array.from(documents).slice(0, 100).map((page, index) => ({ id: "page-" + index, name: page.getAttribute("name") || "第" + (index + 1) + "页" }));
    } catch { return []; }
  };
  window.addEventListener("message", (event) => {
    if (event.source === window.parent && isAllowedParentOrigin(event.origin) && (!parentOrigin || event.origin === parentOrigin)) {
      const message = event.data;
      if (message && message.type === "release-session" && exact(message, ["type", "sessionId"]) && id(message.sessionId)) {
        raw({action:"patent-release-session",sessionId:message.sessionId});
        return;
      }
      if (!validCommand(message) || bytes(message) > maxMessageBytes) return;
      parentOrigin ||= event.origin;
      if (!sameContext(message) && (message.type !== "activate-session" || activeExport || exportQueue.length)) { window.parent.postMessage({ sessionId: message.sessionId, projectId: message.projectId, projectRevision: message.projectRevision, requestId: message.requestId, type: "error", code: "CONTEXT_MISMATCH", message: "流程图会话已失效。" }, parentOrigin); return; }
      context = { sessionId: message.sessionId, projectId: message.projectId, projectRevision: message.projectRevision, requestId: message.requestId };
      if (message.type === "activate-session") {
        documentLoaded = false;
        activating = message;
        deferredMode = null;
        raw({action:"patent-activate-session",sessionId:message.sessionId});
      } else if (message.type === "motion-preference") {
        reducedMotion = message.reducedMotion; applyMotionPreference();
      } else if (message.type === "configure") {
        raw({ action: "configure", config: { grid: false, plugins: [], templates: [], help: false, updates: false, cloud: false } });
      } else if (message.type === "load" && typeof message.source === "string" && bytes(message.source) <= maxSourceBytes) {
        documentLoaded = false;
        activePageId = null;
        pages = parsePages(message.source);
        raw({ action: "load", xml: message.source, autosave: 1, saveAndExit: 0, modified: 0 });
      } else if (message.type === "request-save") {
        enqueueExport({ kind: "save", requestId: message.requestId, format: "xml", selectionOnly: false, finishEditing: message.finishEditing !== false, preserveEditing: message.preserveEditing === true });
      } else if (message.type === "request-export") {
        enqueueExport({ kind: message.format === "drawio" ? "source-export" : "export", requestId: message.requestId, format: message.format, selectionOnly: message.selectionOnly, allPages: message.allPages === true, pageId: message.pageId, selectedCellIds: message.selectedCellIds });
      } else if (message.type === "set-page") {
        raw({ action: "patent-set-page", pageId: message.pageId });
      } else if (message.type === "set-editor-mode") {
        if (!documentLoaded) deferredMode = message.mode;
        else raw({ action: "patent-set-editor-mode", mode: message.mode });
      } else if (["undo", "redo"].includes(message.type)) {
        raw({ action: "patent-command", command: message.type });
      } else if (message.type === "toolbar-action-ack") {
        raw({ action: "patent-toolbar-action-ack", actionId: message.actionId });
      } else if (message.type === "toolbar-state") {
        raw({ action: "patent-toolbar-state", state: { projectName: message.projectName, activePageName: message.activePageName, saveStatus: message.saveStatus, dirty: message.dirty, saveBusy: message.saveBusy, exportBusy: message.exportBusy, canUndo: message.canUndo, canRedo: message.canRedo, canReplaceDrawing: message.canReplaceDrawing ?? false } });
      } else if (message.type === "dispose") {
        context = null; activeExport = null; exportQueue.splice(0); documentLoaded = false;
      }
      return;
    }
    if (event.source !== editor.contentWindow || event.origin !== editorOrigin || typeof event.data !== "string") return;
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message.event !== "string") return;
    // The nested editor can initialize before the outer iframe's load/configure.
    // Keep this readiness even when a parent session has not been assigned yet.
    if (message.event === "init") { ready = true; for (const queued of pendingRaw.splice(0)) raw(queued); pumpExport(); return; }
    if (!context) return;
    if (message.event === "session-error" && activating && message.sessionId === activating.sessionId) {
      activating = null;
      send("error", {code:"SESSION_RESTORE_FAILED",message:"流程图编辑状态恢复失败，请返回原专利重试。"});
      return;
    }
    if (message.event === "session-activated" && activating && message.sessionId === activating.sessionId) {
      if (message.restored && validPagesMessage(message)) {
        activating = null; documentLoaded = true;
        pages = message.pages; activePageId = message.activePageId;
        send("ready", {pages, activePageId: activePageId || undefined});
        send("history-state", {canUndo: message.canUndo, canRedo: message.canRedo});
        send("selection-changed", {selectionCount:message.selectedCellIds.length,selectedCellIds:message.selectedCellIds});
        if (deferredMode) raw({action:"patent-set-editor-mode",mode:deferredMode});
      } else if (message.restored === false) {
        const source = activating.source;
        activating = null;
        pages = parsePages(source); activePageId = null;
        raw({action:"load",xml:source,autosave:1,saveAndExit:0,modified:0});
      }
      return;
    }
    // Old autosave/page/selection messages cannot be attributed to the new owner
    // until the single native runtime acknowledges the session barrier.
    if (activating) return;
    if (message.event === "toolbar-action" && exact(message, ["event", "action", "actionId"]) && toolbarActions.includes(message.action) && id(message.actionId)) { send("toolbar-action", { action: message.action, actionId: message.actionId }); return; }
    if (message.event === "history-state" && exact(message, ["event", "canUndo", "canRedo"]) && typeof message.canUndo === "boolean" && typeof message.canRedo === "boolean") { send("history-state", { canUndo: message.canUndo, canRedo: message.canRedo }); return; }
    if (message.event === "editor-mode" && exact(message, ["event", "mode"]) && ["flowchart", "circuit"].includes(message.mode)) { send("editor-mode-changed", { mode: message.mode }); return; }
    if (message.event === "editor-mode-error" && exact(message, ["event", "code"]) && message.code === "LIBRARY_MODE_FAILED") { send("error", { code: "LIBRARY_MODE_FAILED", message: "图库模式切换失败，已保留原模式。" }); return; }
    if (message.event === "load") { documentLoaded = true; send("ready", { pages, activePageId: activePageId || pages[0]?.id }); if(deferredMode) raw({action:"patent-set-editor-mode",mode:deferredMode}); return; }
    if (message.event === "autosave" && documentLoaded && typeof message.xml === "string") { send("changed"); return; }
    if (message.event === "selection" && Array.isArray(message.selectedCellIds) && message.selectedCellIds.length <= 50000 && message.selectedCellIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 500) && message.selectionCount === message.selectedCellIds.length) { send("selection-changed", { selectionCount: message.selectionCount, selectedCellIds: message.selectedCellIds }); return; }
    if (message.event === "pages" && validPagesMessage(message)) {
      pages = message.pages;
      activePageId = message.activePageId;
      if (documentLoaded) send("ready", { pages, activePageId: message.activePageId || undefined });
      if (message.activePageId) send("page-changed", { pageId: message.activePageId });
      return;
    }
    if (message.event === "export" && activeExport) {
      const request = activeExport; activeExport = null; context.requestId = request.requestId;
      if (request.kind === "save") {
        if (typeof message.xml !== "string") { send("error", { code: "SAVE_SOURCE_MISSING", message: "流程图源文件保存失败。" }); pumpExport(); return; }
        if (bytes(message.xml) > maxSourceBytes) { send("error", { code: "SOURCE_TOO_LARGE", message: "流程图源文件过大。" }); pumpExport(); return; }
        pages = parsePages(message.xml); send("autosave", { source: message.xml }); pumpExport(); return;
      }
      if (request.kind === "source-export") {
        if (typeof message.xml !== "string") { send("error", { code: "EXPORT_SOURCE_MISSING", message: "流程图源文件导出失败。" }); pumpExport(); return; }
        if (bytes(message.xml) > maxSourceBytes) { send("error", { code: "SOURCE_TOO_LARGE", message: "流程图源文件过大。" }); pumpExport(); return; }
        send("export-result", { format: request.format, data: message.xml }); pumpExport(); return;
      }
      const data = typeof message.data === "string" ? message.data : null;
      if (data === null) send("error", { code: "EXPORT_RESULT_MISSING", message: "流程图导出失败。" });
      else send("export-result", { format: request.format, data });
      pumpExport(); return;
    }
    if (message.event === "status" && message.message === "modified" && documentLoaded) send("changed");
  });
})();\n`;

export async function publishDrawioBundle({
  rootDirectory = ROOT,
  stageRoot,
  copyDirectory = cp,
  move = rename,
  remove = rm,
}) {
  const resourceRoot = join(rootDirectory, "resources");
  const targetBundle = join(resourceRoot, "drawio");
  const targetLicenses = join(resourceRoot, "licenses", "drawio");
  const releaseBundle = join(resourceRoot, `.drawio-release-${process.pid}`);
  const releaseLicenses = join(resourceRoot, "licenses", `.drawio-release-${process.pid}`);
  const backupBundle = join(resourceRoot, `.drawio-backup-${process.pid}`);
  const backupLicenses = join(resourceRoot, "licenses", `.drawio-backup-${process.pid}`);
  let movedBundle = false;
  let movedLicenses = false;
  let releasedBundle = false;
  let releasedLicenses = false;
  let publicationComplete = false;
  try {
    await remove(releaseBundle, { recursive: true, force: true });
    await remove(releaseLicenses, { recursive: true, force: true });
    await mkdir(releaseBundle, { recursive: true });
    await mkdir(releaseLicenses, { recursive: true });
    await copyDirectory(join(targetBundle, "upstream.json"), join(releaseBundle, "upstream.json"));
    try {
      await stat(join(targetBundle, "localization"));
      await copyDirectory(join(targetBundle, "localization"), join(releaseBundle, "localization"), {
        recursive: true,
      });
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
    await copyDirectory(join(stageRoot, "app"), join(releaseBundle, "app"), { recursive: true });
    await copyDirectory(join(stageRoot, "templates"), join(releaseBundle, "templates"), {
      recursive: true,
    });
    await copyDirectory(join(stageRoot, "runtime"), join(releaseBundle, "runtime"), {
      recursive: true,
    });
    await copyDirectory(join(stageRoot, "manifest.json"), join(releaseBundle, "manifest.json"));
    for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
      await copyDirectory(join(stageRoot, name), join(releaseLicenses, name));
    }
    await move(targetBundle, backupBundle);
    movedBundle = true;
    await move(releaseBundle, targetBundle);
    releasedBundle = true;
    await move(targetLicenses, backupLicenses);
    movedLicenses = true;
    await move(releaseLicenses, targetLicenses);
    releasedLicenses = true;
    publicationComplete = true;
  } catch (error) {
    if (!publicationComplete) {
      if (releasedLicenses) await remove(targetLicenses, { recursive: true, force: true });
      if (movedLicenses) await move(backupLicenses, targetLicenses);
      if (releasedBundle) await remove(targetBundle, { recursive: true, force: true });
      if (movedBundle) await move(backupBundle, targetBundle);
    }
    throw error;
  } finally {
    await remove(releaseBundle, { recursive: true, force: true });
    await remove(releaseLicenses, { recursive: true, force: true });
    if (publicationComplete) {
      for (const backup of [backupBundle, backupLicenses]) {
        try {
          await remove(backup, { recursive: true, force: true });
        } catch (error) {
          console.warn(
            `draw.io backup cleanup failed; preserving ${backup}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
}

async function clonePinnedUpstream() {
  const temporaryRoot = join(process.env.TEMP ?? process.cwd(), "patent-workbench-drawio-v30.0.4");
  try {
    await stat(join(temporaryRoot, ".git"));
  } catch {
    const proxyArgs = projectGitProxyArgs(await runGitConfig("^(http|https)\\.proxy$"));
    await run("git", [
      ...proxyArgs,
      "clone",
      "--depth",
      "1",
      "--branch",
      DRAWIO_POLICY.upstream.tag,
      DRAWIO_POLICY.upstream.repository,
      temporaryRoot,
    ]);
  }
  return temporaryRoot;
}

export function projectGitProxyArgs(configOutput) {
  const proxies = new Map();
  for (const line of configOutput.split(/\r?\n/u)) {
    const separator = line.search(/\s/u);
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if ((key === "http.proxy" || key === "https.proxy") && value) {
      proxies.set(key, value);
    }
  }
  return [
    ...(proxies.has("http.proxy") ? ["-c", `http.proxy=${proxies.get("http.proxy")}`] : []),
    ...(proxies.has("https.proxy") ? ["-c", `https.proxy=${proxies.get("https.proxy")}`] : []),
  ];
}

async function runGitConfig(pattern) {
  try {
    return await run("git", ["-C", ROOT, "config", "--get-regexp", pattern]);
  } catch {
    return "";
  }
}

export async function verifyPinnedUpstream(
  sourceDirectory,
  readHead = null,
  readTag = null,
  readStatus = null,
) {
  const head = (
    await (readHead ?? ((directory) => run("git", ["-C", directory, "rev-parse", "HEAD"])))(
      sourceDirectory,
    )
  ).trim();
  if (head !== DRAWIO_POLICY.upstream.commit) {
    throw new Error(
      `draw.io checkout HEAD ${head} does not match ${DRAWIO_POLICY.upstream.commit}`,
    );
  }
  const tag = (
    await (
      readTag ??
      ((directory) => run("git", ["-C", directory, "describe", "--exact-match", "--tags", "HEAD"]))
    )(sourceDirectory)
  ).trim();
  if (tag !== DRAWIO_POLICY.upstream.tag) {
    throw new Error(`draw.io checkout tag ${tag} does not match ${DRAWIO_POLICY.upstream.tag}`);
  }
  const status = (
    await (readStatus ?? ((directory) => run("git", ["-C", directory, "status", "--porcelain"])))(
      sourceDirectory,
    )
  ).trim();
  if (status) throw new Error("draw.io checkout contains uncommitted changes");
}

async function assertNoSymbolicLinks(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = join(prefix, entry.name).replaceAll("\\", "/");
    if (entry.isSymbolicLink())
      throw new Error(`draw.io source/output tree contains a symbolic link: ${relativePath}`);
    if (entry.isDirectory()) await assertNoSymbolicLinks(root, relativePath);
  }
}

async function writePatentTemplates(templateRoot) {
  await mkdir(templateRoot, { recursive: true });
  const templates = {
    "patent-basic-flowchart": "基本流程图",
    "patent-system-flow": "系统流程图",
    "patent-method-flow": "方法流程图",
  };
  for (const [name, title] of Object.entries(templates)) {
    const xml = `<mxfile host="PatentWorkbench"><diagram name="${title}"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>\n`;
    await writeFile(join(templateRoot, `${name}.drawio`), xml, "utf8");
  }
}

async function stageLicenseMaterials(stageRoot) {
  const sourceLicense = await readFile(join(stageRoot, "LICENSE"));
  const expectedLicense = await readFile(join(LICENSE_ROOT, "LICENSE"));
  if (
    !sourceLicense.equals(expectedLicense) ||
    createHash("sha256").update(sourceLicense).digest("hex") !== DRAWIO_LICENSE_HASH ||
    createHash("sha256").update(expectedLicense).digest("hex") !== DRAWIO_LICENSE_HASH
  ) {
    throw new Error("draw.io upstream LICENSE does not match the pinned v30.0.4 license material");
  }
  await writeFile(join(stageRoot, "LICENSE"), expectedLicense);
  for (const name of ["NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    await cp(join(LICENSE_ROOT, name), join(stageRoot, name));
  }
}

export async function createManifest(root) {
  const files = (await listFiles(root)).filter(
    (relativePath) =>
      relativePath !== "app/surface-adaptation.js" &&
      (relativePath.startsWith("app/") || relativePath.startsWith("templates/")),
  );
  return {
    upstream: DRAWIO_POLICY.upstream,
    files: await Promise.all(
      files
        .sort((left, right) => left.localeCompare(right, "en"))
        .map(async (relativePath) => {
          const bytes = await readFile(join(root, relativePath));
          return {
            path: relativePath,
            bytes: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        }),
    ),
  };
}

async function listFiles(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = join(prefix, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) files.push(...(await listFiles(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`${command} ${args.join(" ")} failed: ${output.trim()}`));
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await vendorDrawio();
  } catch (error) {
    console.error(
      `draw.io vendor failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
