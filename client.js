window.__ModuleLoader__.load({
  // Must stay identical to the published package name; DSH matches the sidebar
  // client bundle by this id and silently skips loading if it drifts.
  id: 'dsh-workflow-canvas',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useRef = React.useRef;
    const useEffect = React.useEffect;
    const Component = React.Component;

    /** Resolved lazily so a missing namespace can never fail plugin load. */
    let workspaceFilesService = null;
    function resolveWorkspaceFiles(ctx) {
      if (workspaceFilesService) return workspaceFilesService;
      try {
        if (ctx && typeof ctx.get === 'function') {
          workspaceFilesService = ctx.get('remote.workspaceFiles') || null;
        }
      } catch (_e) { /* service absent */ }
      if (!workspaceFilesService) {
        try {
          workspaceFilesService = (ctx && ctx.remote && ctx.remote.workspaceFiles) || null;
        } catch (_e) { /* proxy refuses unknown namespaces */ }
      }
      return workspaceFilesService;
    }

    const TAB_ID = '@local/dsh-workflow-canvas';
    const KIND = 'workflow';
    const STORAGE_PREFIX = 'dsh-workflow-canvas:v1:';
    const PRESET_KEY = STORAGE_PREFIX + 'presets';
    const SHORTCUTS_KEY = STORAGE_PREFIX + 'shortcuts';
    const DEFAULT_SHORTCUTS = {
      addNode: 'Shift+A',
      duplicate: 'Shift+D',
      delete: 'Delete',
      undo: 'Ctrl+Z',
      redo: 'Ctrl+Shift+Z',
      fitView: '',
      autoLayout: '',
      toggleDir: '',
    };
    const SHORTCUT_ORDER = ['addNode', 'duplicate', 'delete', 'undo', 'redo', 'fitView', 'autoLayout', 'toggleDir'];

    const NODE_W = 216;
    const NODE_H = 234;
    const PORT = 12;
    const SOCKET_BAND_TOP = 176;
    const ROW_H = 18;
    const COND_ROW_H = 20;
    const BRANCH_COLORS = ['#3fb950', '#e5534b', '#2f81f7', '#d29922', '#a371f7', '#39c5cf', '#f778ba', '#f0883e'];
    const CONTENT_W = 2400;
    const CONTENT_H = 1600;
    /** World origin offset: keeps negative node coordinates inside the scroll area. */
    const WORLD_PAD = 2000;

    const FX_KEY = STORAGE_PREFIX + 'fx';
    const FX_LEVELS = ['minimal', 'standard', 'vivid'];
    const PARALLEL_KEY = STORAGE_PREFIX + 'maxParallel';
    const PARALLEL_STEPS = [1, 2, 4, 6, 8];
    const STYLE_ID = 'dsh-workflow-canvas-styles';

    /** Inject scoped CSS keyframes once; never touches host selectors. */
    function ensureStyles() {
      try {
        if (typeof document === 'undefined' || !document.head) return;
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
          '@keyframes dsh-wc-pulse-ring {',
          '  0%, 100% { box-shadow: 0 0 0 1px rgba(47,129,247,0.45), 0 0 10px rgba(47,129,247,0.16); }',
          '  50% { box-shadow: 0 0 0 2px rgba(47,129,247,0.8), 0 0 18px rgba(47,129,247,0.34); }',
          '}',
          '@keyframes dsh-wc-pulse-vivid {',
          '  0%, 100% { box-shadow: 0 0 0 2px rgba(47,129,247,0.55), 0 0 14px rgba(47,129,247,0.28); }',
          '  50% { box-shadow: 0 0 0 3px rgba(47,129,247,0.92), 0 0 28px rgba(47,129,247,0.52); }',
          '}',
          '@keyframes dsh-wc-dash {',
          '  from { stroke-dashoffset: 28; }',
          '  to { stroke-dashoffset: 0; }',
          '}',
          '@keyframes dsh-wc-shimmer {',
          '  0% { background-position: 200% 0; }',
          '  100% { background-position: -200% 0; }',
          '}',
          '@keyframes dsh-wc-dot {',
          '  0%, 100% { opacity: 1; transform: scale(1); }',
          '  50% { opacity: 0.42; transform: scale(0.82); }',
          '}',
          '.dsh-wc-node { transition: box-shadow 180ms ease, border-color 180ms ease, opacity 180ms ease; }',
          '.dsh-wc-node:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.24); }',
          '.dsh-wc-running-std { animation: dsh-wc-pulse-ring 2.1s ease-in-out infinite; }',
          '.dsh-wc-running-vivid { animation: dsh-wc-pulse-vivid 1.65s ease-in-out infinite; }',
          '.dsh-wc-topbar-vivid { background-size: 220% 100% !important; animation: dsh-wc-shimmer 1.8s linear infinite; }',
          '.dsh-wc-edge-flow { stroke-dasharray: 8 6; animation: dsh-wc-dash 0.8s linear infinite; }',
          '.dsh-wc-dot-live { display: inline-block; animation: dsh-wc-dot 1.5s ease-in-out infinite; }',
        ].join('\n');
        document.head.appendChild(style);
      } catch (_e) { /* non-DOM or restricted host */ }
    }

    // One socket per channel type: a link can only join the same type.
    const SOCKET_TYPES = [
      { id: 'prompt', label: 'prompt', color: '#8a8f98' },
      { id: 'structured', label: 'structured', color: '#2f81f7' },
      { id: 'session-ref', label: 'session', color: '#a371f7' },
    ];

    /** Fallback effort ids when the model catalog carries no reasoning metadata. */
    const REASONING_FALLBACK = ['low', 'medium', 'high'];

    const LANG_KEY = STORAGE_PREFIX + 'lang';
    const I18N = {
      zh: {
        addAgent: '+ 子代理', addLead: '+ Lead', addCond: '+ 条件', undo: '↶ 撤销', redo: '↷ 重做', sync: '↥ 同步',
        enabled: '● 已启用', disabled: '○ 已禁用', presetName: '预设名', save: '☆ 保存',
        presets: '☰ 预设', unsaved: '有未同步改动', synced: '已同步',
        pickModel: '选择模型', loadingModels: '加载中…', defaultEffort: '默认',
        leadThis: 'Lead（本对话）',
        tipSocketOut: '通用输入口（接收 prompt / structured / session / 条件分支）；拖出可断开最近一条连线',
        tipSocketIn: '从这里拖出连线 / 也可以把输入口拖到这里',
        tipCondTrue: '条件满足（pass=true）时走这条分支，连到任意下游节点左侧入口',
        tipCondFalse: '条件不满足（pass=false）时走这条分支，连到任意下游节点左侧入口',
        tipBranchOut: '命中该分支时走这条连线，拖到任意下游节点左侧入口',
        branchTrue: '是',
        branchFalse: '否',
        addBranch: '+ 分支',
        branchPh: '分支名',
        delBranchTip: '删除该分支（至少保留 2 路）',
        matchSingle: '单选',
        matchMulti: '多选',
        tipMatchMode: '单选：最多命中 1 条最匹配分支（全不满足则跳过中间分支并直达最近 Lead）；多选：所有满足条件的分支同时并行执行，全不满足则直达最近 Lead',
        tipExpandEdit: '展开大输入框编辑',
        tipExpandBranch: '展开大输入框编辑该分支的条件',
        branchEditTitle: '分支条件',
        condLabel: '条件',
        condPh: '判断条件或分流规则：例如成功走「是」，失败走「否」',
        delNodeTip: '删除节点（可用 ↶ 撤销 找回）',
        deletedNode: '节点已删除，可点「撤销」找回',
        orphanTip: '未连线：运行时会被跳过',
        syncOff: '自动同步不可用',
        syncNoSession: '无会话 id',
        syncReadFail: '读取失败: ',
        syncApplied: '已应用生成结果',
        syncBadFile: '文件内容无效',
        generated: '已从对话生成画布',
        dupName: '已存在，请换一个名字',
        guideDesc: '画一张子代理流程图',
        model: '模型', reason: '推理', role: '分工', task: '任务', taskPh: '本次任务：例如把这批反馈归类并给出建议',
        rolePhLead: '我自己这一步做什么', rolePhAgent: '这个子代理做什么',
        memory: '记忆', scope: '能力', retry: '重试', jsonOut: 'JSON 输出',
        sep: ': ', on: '开', off: '关', allTools: '默认（全部工具）', none: '无',
        scopeMinimal: 'minimal（只读思考）', scopeStandard: 'standard（全部工具）',
        fallbackModel: '备用',
        stPending: '未执行', stRunning: '进行中', stDone: '已完成', stFailed: '失败',
        stOrphan: '未连线', stLead: '由对话执行', stLeadReady: '待拍板',
        presetEmpty: '保存后可在任意新对话一键载入', del: '删除这个预设',
        presetSaveTitle: '保存当前画布（可在新会话一键载入）',
        presetNamePh: '起个名字后回车保存…',
        myPresets: '我的预设（跨会话复用）',
        needName: '请先给预设起个名字', duplicate: '已存在，请换一个名字',
        savedPreset: '已保存预设', saveFailed: '保存失败（存储不可用）',
        loadedPreset: '已载入预设', invalidPreset: '预设内容无效', deletedPreset: '已删除预设',
        syncFailed: '同步失败', upToDate: '已是最新', syncedToHost: '已同步到 Host',
        syncedWithStdWarn: '已同步（含可写/命令节点，请确认主对话权限已放开）',
        cannotOpen: '无法打开会话', undoDone: '已撤销', undoNone: '没有可撤销的操作', redoDone: '已重做', redoNone: '没有可重做的操作',
        leadLocked: '入口 Lead 不能删除', modelsMissing: '模型列表未加载',
        tipLead: 'Lead 步骤在对话里执行，画布不追踪其状态',
        tipOrphan: '未连线：运行时会被跳过', tipStatus: '子代理节点的运行状态',
        tipZoom: '滚轮缩放（以光标为中心）',
        tipResetZoom: '点击回到 100% 并聚焦 Lead；左右拖拽可连续缩放',
        tipLocate: '自适应缩放并居中，让所有节点完整显示在视野内',
        locate: '⊡ 全览',
        importBtn: '⇩ 导入',
        tipImport: '从剪贴板导入模型生成的画布（先复制聊天里的画布 JSON）',
        importOk: '已导入画布，共 ',
        tipMore: '更多',
        help: '使用说明',
        helpTitle: '怎么用这个画布',
        close: '关闭',
        cutLinks: '右键划断连线',
        linkCut: '已断开一条连线',
        tipToggle: '启用/禁用此画布（启用后我才能执行它）',
        helpBody: [
          '1. 在入口 Lead 里写「本次任务」，这是整张图的总目标。',
          '2. 点「+ 子代理 / + Lead / + 条件」加节点，从右侧输出口拖到另一个节点左侧输入口即可连线。',
          '3. 输出口决定连线类型：prompt（灰，纯文本）、structured（蓝，JSON）、session（紫，复用上游会话）；条件节点支持多路分支（单选 switch/case 或多选并行，全不满足时跳过中间分支直达最近 Lead）。',
          '4. 节点左侧为统一通用输入口，可直接接收任意颜色的连线；拖已连接的左口可断开最近一条连线。',
          '5. 每个节点可设模型、推理强度、能力范围、备用模型、是否记忆；复杂任务/分工/条件可点 ⤢ 展开大框编辑。',
          '6. 连好后点「● 已启用」，然后对对话说「跑一次」，由我调用执行。',
          '7. 遇到 Lead 节点会暂停，我做完再把结果交回去继续。',
          '8. 没连线的节点显示为虚线，运行时会被跳过。',
          '9. 右键单击节点 / 连线 / 空白处可弹出快捷菜单（含线上插点、复制删除、新建节点等）；按住右键划过连线可切断（可在「⋯」开关）。',
          '10. 点右上角「☰ 预设」顶部即可保存当前画布，开新对话时一键载入跨会话复用。',
          '11. 你可以直接让我改画布：说「把那三个节点的分工改成…」，我会就地修改，不动你摆的位置。',
          '12. session 线连到 Lead 时，我会在暂停那步拿到那个子代理的会话，可以继续追问它。',
          '13. 按住鼠标中键（或空格 + 左键）拖动画布平移；点击子代理节点左下角状态可直达它的对话记录。',
          '14. 快捷键：默认 Shift+A 新建节点，Shift+D 复制节点与连线，Delete 删除，Ctrl+Z 撤销，Esc 关闭弹窗（可在「⋯ → 快捷键设置」自定义）。',
        ].join('\n'),
        openChat: '会话',
        tipOpenRun: '点击打开该子代理的对话记录',
        exportBtn: '⇧ 复制 JSON',
        exportOk: '已复制画布 JSON 到剪贴板',
        exportFail: '复制失败（剪贴板不可用）',
        autoLayoutBtn: '⊞ 自动排版',
        layoutDone: '已自动整理布局',
        clearCanvasBtn: '✕ 清空画布',
        newBlankCanvas: '＋ 新建空白画布',
        clearedCanvas: '已清空画布（可用 ↶ 撤销）',
        cycleBlocked: '不能形成环，已阻止连线',
        leadToLeadBlocked: 'Lead 节点不能直接连到另一个 Lead，请在中间放入子代理',
        builtinTemplates: '内置示例模板',
        duplicatedNodes: '已复制节点',
        deletedNodes: '已删除节点（可用 ↶ 撤销）',
        addMenuTitle: '新建节点 (Shift+A)',
        addMenuLinkTitle: '拖线新建并自动连线',
        stPruned: '已跳过',
        tipPruned: '未被条件分支命中，已跳过执行（不消耗额度）',
        verdictReasonTitle: '条件判决理由',
        verdictMatched: '命中分支：',
        verdictFallback: '已跳过中间分支 → 转交 Lead：',
        verdictNoReason: '（裁判未附额外说明）',
        tipVerdictChip: '点击查看完整判断理由',
        runBtn: '▶ 运行',
        runBtnRunning: '进行中…',
        runBtnWaiting: '⏸ 等待决策',
        runStarted: '已向当前会话发起画布执行',
        runFailed: '发起运行失败',
        runSendUnavailable: '当前宿主不支持从画布直接发起对话，请在聊天框发送消息启动',
        dirLR: '⇄ 横排',
        dirTB: '⇅ 竖排',
        tipDir: '切换画布流向（横排 → / 竖排 ↓），竖排更适合窄侧边栏，切换时自动重排（可 ↶ 撤销）',
        condSideR: '右出',
        condSideL: '左出',
        tipCondSide: '竖排模式下切换分支输出口在左侧或右侧',
        refsBtn: '参考',
        refsTitleGlobal: '全局参考 / 约束（注入所有节点）',
        refsTitleNode: '节点参考 / 约束',
        refsAdd: '+ 添加参考',
        refsPh: '文件路径、URL 或约束条款，如 src/auth.js',
        refsEmpty: '点击下方按钮添加参考文件、路径或规范约束（最多 16 条）',
        tipRefs: '附加参考文件、目录或约束清单，运行时自动注入提示词',
        delRefTip: '删除该参考项',
        ctxNodeTitle: '节点操作',
        ctxEdgeTitle: '连线操作',
        ctxCanvasTitle: '画布操作',
        ctxDup: '复制节点',
        ctxDelNode: '删除节点',
        ctxOpenChat: '打开子代理对话 ↗',
        ctxEditText: '展开编辑文本',
        ctxManageRefs: '管理参考清单',
        ctxDelEdge: '删除连线',
        ctxInsertAgent: '在此插入子代理',
        ctxInsertCond: '在此插入条件节点',
        ctxLangToggle: '界面语言',
        shortcutsMenu: '⌨ 快捷键设置',
        shortcutsTitle: '快捷键设置',
        shortcutsHint: '点击右侧按键框后按下新组合键；按 Esc 取消录制，点 × 清除绑定。',
        shortcutsReset: '恢复默认',
        shortcutsPress: '请按键…',
        shortcutsUnset: '未设置',
        shortcutsResetOk: '快捷键已恢复默认',
        shortcutsConflict: '已更新快捷键（原冲突项已清空）',
        scAddNode: '新建节点（光标处）',
        scDuplicate: '复制选中节点与连线',
        scDelete: '删除选中节点',
        scUndo: '撤销',
        scRedo: '重做',
        scFitView: '全览居中',
        scAutoLayout: '自动排版',
        scToggleDir: '切换横排 / 竖排',
        fxLabel: '视觉效果',
        fxMinimal: '极简',
        fxStandard: '标准',
        fxVivid: '炫酷',
        maxParallelLabel: '最大并发',
        tipMaxParallel: '默认 4 路并行（可选 1 / 2 / 4 / 6 / 8）。并发过高容易触发 API 限流（429）、增加多子代理同时写同一工作区的文件冲突，并放大单轮报错时的额度消耗；纯只读调研可适当调高。',
        tipLeadReady: '上游节点已全部完成，正等待在对话里拍板继续',
        stDeadEnd: '无出边',
        tipDeadEnd: '该子代理没有下游连线，运行时不生效；请连入下游节点或终审 Lead',
        stSoloLead: '待填分工',
        tipSoloLead: '该 Lead 阶段未连入子代理且分工为空，填写分工后即可作为主对话阶段运行',
        singleModelHint: '当前仅 1 个可用模型，暂无其它备用路由',
        importNone: '剪贴板里没有可识别的画布数据',
        importBad: '画布数据格式不对',
        tipSync: '把当前画布同步给 Host（会在对话里留一条同步记录）',
        tipUndo: '撤销上一步结构改动', tipRedo: '重做上一步撤销的改动（Ctrl+Shift+Z / Ctrl+Y）', tipSave: '把当前画布保存为预设（可在新会话载入）',
        tipPresets: '保存当前画布、跨会话复用，或载入内置模板', tipModel: '推理等级（默认 = 该模型声明的 defaultEffort）',
        tipMemory: '记忆：复用这个节点上一次的会话（跨运行及重启后可恢复）',
        memLatest: '最新',
        memLatestOpt: '自动（最新记忆）',
        memRunOpt: '第 {n} 次会话',
        memEmpty: '运行后这里会列出可选的历史会话',
        tipMemoryPick: '选择要续接的历史子会话（默认自动沿用最新记忆）',
        tipPreset: '能力范围（点一下切换，受主对话权限上限约束）：standard = 全部工具（读写文件、跑命令、子代理、工作流、网页、办公）；minimal = 只读思考（文件读写关闭，没有子代理/工作流/网页）',
        tipFallback: '失败重试：该节点出错时自动换一个模型再跑一次',
        tipStructured: 'JSON 输出：要求该节点返回 JSON 对象，structured 连线会把结果作为 JSON 传给下游',
        lang: 'ZH',
      },
      en: {
        addAgent: '+ Subagent', addLead: '+ Lead', addCond: '+ Condition', undo: '↶ Undo', redo: '↷ Redo', sync: '↥ Sync',
        enabled: '● ON', disabled: '○ OFF', presetName: 'Preset name', save: '☆ Save',
        presets: '☰ Presets', unsaved: 'Unsaved changes', synced: 'Synced',
        pickModel: 'Pick a model', loadingModels: 'Loading…', defaultEffort: 'default',
        leadThis: 'Lead (this chat)',
        tipSocketOut: 'Universal input (accepts prompt / structured / session / branch); drag away to detach latest link',
        tipSocketIn: 'Drag out to link, or drop an input here',
        tipCondTrue: 'Runs when condition passes (pass=true); connect to any downstream input',
        tipCondFalse: 'Runs when condition fails (pass=false); connect to any downstream input',
        tipBranchOut: 'Runs when this branch matches; connect to any downstream input',
        branchTrue: 'Yes',
        branchFalse: 'No',
        addBranch: '+ Case',
        branchPh: 'Branch name',
        delBranchTip: 'Remove this branch (minimum 2)',
        matchSingle: 'Single',
        matchMulti: 'Multi',
        tipMatchMode: 'Single: pick at most 1 best-matching branch (if none match, skip branches and jump to nearest Lead). Multi: run all matching branches in parallel (if none match, jump to nearest Lead).',
        tipExpandEdit: 'Expand larger editor',
        tipExpandBranch: 'Expand larger editor for this branch condition',
        branchEditTitle: 'Branch condition',
        condLabel: 'Condition',
        condPh: 'Condition or switch rule, e.g. pass vs minor fix vs rewrite',
        delNodeTip: 'Delete this node (undo with ↶)',
        deletedNode: 'Node deleted, use Undo to restore it',
        orphanTip: 'Unlinked: skipped when the canvas runs',
        syncOff: 'Auto-sync unavailable',
        syncNoSession: 'No session id',
        syncReadFail: 'Read failed: ',
        syncApplied: 'Generated canvas applied',
        syncBadFile: 'File content is invalid',
        generated: 'Canvas generated from chat',
        dupName: 'already exists, pick another name',
        guideDesc: 'Sketch a subagent workflow',
        model: 'Model', reason: 'Reasoning', role: 'Role', task: 'Task', taskPh: 'Task, e.g. classify these reports and suggest actions',
        rolePhLead: 'What I do in this step', rolePhAgent: 'What this subagent does',
        memory: 'Memory', scope: 'Scope', retry: 'Retry', jsonOut: 'JSON out',
        sep: ': ', on: 'on', off: 'off', allTools: 'default (all tools)', none: 'none',
        scopeMinimal: 'minimal (read-only thinking)', scopeStandard: 'standard (all tools)',
        fallbackModel: 'Fallback',
        stPending: 'Pending', stRunning: 'Running', stDone: 'Done', stFailed: 'Failed',
        stOrphan: 'Unlinked', stLead: 'Runs in chat', stLeadReady: 'Ready',
        presetEmpty: 'Saved canvases appear here in every new chat', del: 'Delete this preset',
        presetSaveTitle: 'Save current canvas (reuse in any new chat)',
        presetNamePh: 'Name this canvas…',
        myPresets: 'Saved presets (all sessions)',
        needName: 'Name the preset first', duplicate: 'already exists, pick another name',
        savedPreset: 'Saved preset', saveFailed: 'Save failed (storage unavailable)',
        loadedPreset: 'Loaded preset', invalidPreset: 'Preset content is invalid', deletedPreset: 'Deleted preset',
        syncFailed: 'Sync failed', upToDate: 'Already up to date', syncedToHost: 'Synced to host',
        syncedWithStdWarn: 'Synced (has write/tool nodes — check main chat permission mode)',
        cannotOpen: 'Cannot open the session', undoDone: 'Undone', undoNone: 'Nothing to undo', redoDone: 'Redone', redoNone: 'Nothing to redo',
        leadLocked: 'The entry Lead cannot be deleted', modelsMissing: 'Model list is not loaded',
        tipLead: 'Lead steps run in the chat; the canvas does not track them',
        tipOrphan: 'Unlinked: skipped when the canvas runs', tipStatus: 'Subagent run status',
        tipZoom: 'Wheel zooms around the cursor',
        tipResetZoom: 'Click to reset to 100% on Lead; drag left/right to scrub zoom',
        tipLocate: 'Fit all nodes into the visible canvas',
        locate: '⊡ Fit',
        importBtn: '⇩ Import',
        tipImport: 'Import a model-generated canvas from the clipboard (copy the canvas JSON from chat first)',
        importOk: 'Canvas imported, ',
        tipMore: 'More',
        help: 'How to use',
        helpTitle: 'Using this canvas',
        close: 'Close',
        cutLinks: 'Right-drag to cut links',
        linkCut: 'Link cut',
        tipToggle: 'Enable or disable this canvas (I can only run it while enabled)',
        helpBody: [
          '1. Write the overall task in the entry Lead node.',
          '2. Add nodes with + Subagent / + Lead / + Condition, then drag from a right socket to a left socket.',
          '3. Output sockets choose channel type: prompt (grey text), structured (blue JSON), session (purple warm session), or multi-way condition branches (single switch/case or parallel multi-match; jumps to nearest Lead if none match).',
          '4. Every node has one universal left input that accepts any incoming wire; drag a connected input away to detach the latest wire.',
          '5. Each node sets model, reasoning, capability scope, fallback model and memory; click ⤢ to expand a larger editor for long text.',
          '6. Press ● ON, then ask in chat to run the canvas.',
          '7. The run pauses at every Lead node so the conversation can do that step.',
          '8. Unlinked nodes are dashed and skipped at run time.',
          '9. Right-click a node, wire, or blank canvas for context actions (insert on wire, duplicate/delete, add nodes); right-drag across a wire to cut it (toggle under ⋯).',
          '10. Open ☰ Presets to save the current canvas at the top and load it in any new chat.',
          '11. You can ask me to edit the canvas; I patch it in place and keep your layout.',
          '12. A session link into a Lead step hands me that child agent, so I can follow up with it.',
          '13. Hold the middle mouse button (or Space + drag) to pan; click a subagent status badge at the bottom-left to open its chat.',
          '14. Shortcuts: Shift+A adds a node at cursor, Shift+D duplicates nodes & links, Delete removes selected, Ctrl+Z undoes, Esc closes popups (customizable under ⋯ → Shortcuts).',
        ].join('\n'),
        openChat: 'Chat',
        tipOpenRun: 'Click to open this subagent conversation',
        exportBtn: '⇧ Copy JSON',
        exportOk: 'Canvas JSON copied to clipboard',
        exportFail: 'Copy failed (clipboard unavailable)',
        autoLayoutBtn: '⊞ Auto layout',
        layoutDone: 'Layout tidied',
        clearCanvasBtn: '✕ Clear canvas',
        newBlankCanvas: '+ New blank canvas',
        clearedCanvas: 'Canvas cleared (use Undo to restore)',
        cycleBlocked: 'Cannot create a cycle',
        leadToLeadBlocked: 'Cannot link a Lead directly to another Lead; place a subagent in between',
        builtinTemplates: 'Starter templates',
        duplicatedNodes: 'Duplicated nodes',
        deletedNodes: 'Deleted nodes (use Undo to restore)',
        addMenuTitle: 'Add node (Shift+A)',
        addMenuLinkTitle: 'Create & connect node',
        stPruned: 'Skipped',
        tipPruned: 'Skipped because no matching condition branch routed here (0 tokens spent)',
        verdictReasonTitle: 'Branch verdict',
        verdictMatched: 'Matched: ',
        verdictFallback: 'Skipped branches → Lead: ',
        verdictNoReason: '(No extra reason provided)',
        tipVerdictChip: 'Click to inspect verdict reason',
        runBtn: '▶ Run',
        runBtnRunning: 'Running…',
        runBtnWaiting: '⏸ Awaiting Lead',
        runStarted: 'Workflow run queued in this chat',
        runFailed: 'Failed to start run',
        runSendUnavailable: 'Direct canvas launch is unavailable in this host; send a message in chat to start',
        dirLR: '⇄ Horiz',
        dirTB: '⇅ Vert',
        tipDir: 'Switch canvas direction (Horizontal → / Vertical ↓). Vertical fits narrow sidebars better and auto-layouts (undoable).',
        condSideR: 'Out R',
        condSideL: 'Out L',
        tipCondSide: 'Flip condition branch sockets between left and right edges in vertical mode',
        refsBtn: 'Refs',
        refsTitleGlobal: 'Global references / rules (all nodes)',
        refsTitleNode: 'Node references / rules',
        refsAdd: '+ Add ref',
        refsPh: 'File path, URL, or rule, e.g. src/auth.js',
        refsEmpty: 'Add reference files, paths, or rules injected into prompts (up to 16)',
        tipRefs: 'Attach reference files, paths, or constraints injected at run time',
        delRefTip: 'Remove this reference',
        ctxNodeTitle: 'Node',
        ctxEdgeTitle: 'Link',
        ctxCanvasTitle: 'Canvas',
        ctxDup: 'Duplicate',
        ctxDelNode: 'Delete',
        ctxOpenChat: 'Open chat ↗',
        ctxEditText: 'Expand editor',
        ctxManageRefs: 'Manage refs',
        ctxDelEdge: 'Delete link',
        ctxInsertAgent: 'Insert Subagent here',
        ctxInsertCond: 'Insert Condition here',
        ctxLangToggle: 'Language',
        shortcutsMenu: '⌨ Shortcuts',
        shortcutsTitle: 'Keyboard Shortcuts',
        shortcutsHint: 'Click a key button then press a new combo. Press Esc to cancel, or × to clear.',
        shortcutsReset: 'Reset defaults',
        shortcutsPress: 'Press keys…',
        shortcutsUnset: 'Unbound',
        shortcutsResetOk: 'Shortcuts reset to defaults',
        shortcutsConflict: 'Shortcut updated (cleared conflict)',
        scAddNode: 'Add node at cursor',
        scDuplicate: 'Duplicate nodes & links',
        scDelete: 'Delete selected nodes',
        scUndo: 'Undo',
        scRedo: 'Redo',
        scFitView: 'Fit all in view',
        scAutoLayout: 'Auto layout',
        scToggleDir: 'Toggle Horiz / Vert layout',
        fxLabel: 'Visual effects',
        fxMinimal: 'Minimal',
        fxStandard: 'Standard',
        fxVivid: 'Vivid',
        maxParallelLabel: 'Max parallel',
        tipMaxParallel: 'Default 4 concurrent subagents (1 / 2 / 4 / 6 / 8). Higher concurrency can trigger API rate limits (429), increase workspace file-edit conflicts, and widen token spend on failure; raising it is safest for read-only research.',
        tipLeadReady: 'Upstream steps are done; waiting for Lead in chat',
        stDeadEnd: 'No out-link',
        tipDeadEnd: 'This subagent has no outgoing link and is skipped at run time; wire it into a downstream node or Lead',
        stSoloLead: 'Needs role',
        tipSoloLead: 'This chained Lead stage has no subagent upstream and an empty role; fill in a role to make it active',
        singleModelHint: 'Only 1 model available — no alternate fallback route',
        importNone: 'No canvas data found in the clipboard',
        importBad: 'Canvas data is malformed',
        tipSync: 'Publish this canvas to the host (leaves one sync record in the chat)',
        tipUndo: 'Undo the last structural change', tipRedo: 'Redo the last undone change (Ctrl+Shift+Z / Ctrl+Y)', tipSave: 'Save this canvas as a preset (reusable in new chats)',
        tipPresets: 'Save this canvas for new chats, or load a preset / starter template', tipModel: 'Reasoning effort (default = the model\'s defaultEffort)',
        tipMemory: 'Memory: reuse this node\'s previous session (persisted across runs and restarts)',
        memLatest: 'Latest',
        memLatestOpt: 'Auto (latest)',
        memRunOpt: 'Run #{n}',
        memEmpty: 'Past runs appear here after running',
        tipMemoryPick: 'Pick which past child session to resume (defaults to latest)',
        tipPreset: 'Capability (click to toggle; bounded by the main chat permission mode): standard = all tools (files, shells, subagents, workflow, web, office); minimal = read-only thinking (no file writes, no subagents/workflow/web)',
        tipFallback: 'Retry: when this node fails, rerun it once on another model',
        tipStructured: 'JSON output: require an object result; structured links pass it downstream as JSON',
        lang: 'EN',
      },
    };

    /** Bilingual string for text read outside the component (tab titles, guide). */
    function pick(zh, en) {
      return loadLang() === 'en' ? en : zh;
    }

    function loadLang() {
      try {
        const v = window.localStorage.getItem(LANG_KEY);
        return v === 'en' ? 'en' : 'zh';
      } catch (_e) {
        return 'zh';
      }
    }

    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      dim: 'var(--dsw-alias-label-tertiary, rgba(140,140,140,0.95))',
      border: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
      raised: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.10))',
      // Chain through host surface tokens before falling back to CSS Canvas so popups
      // stay readable in both light and dark themes (never hardcode a dark hex fallback).
      elevated: 'var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-popover, var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, Canvas))))',
      base: 'var(--dsw-alias-bg-base, transparent)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.18))',
      accent: 'var(--dsw-alias-brand-primary, #2f81f7)',
    };

    const S = {
      root: {
        boxSizing: 'border-box', height: '100%', width: '100%',
        display: 'flex', flexDirection: 'column',
        background: C.base, color: C.text, fontSize: '13px',
      },
      toolbar: {
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '5px',
        padding: '6px 8px', borderBottom: '1px solid ' + C.border, flex: '0 0 auto',
      },
      btn: {
        padding: '4px 8px', borderRadius: '6px', border: '1px solid ' + C.border,
        background: C.raised, color: C.text, fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap',
      },
      btnDirty: {
        padding: '4px 8px', borderRadius: '6px', border: '1px solid ' + C.accent,
        background: C.raised, color: C.accent, fontSize: '11px', fontWeight: 600,
        cursor: 'pointer', whiteSpace: 'nowrap',
      },
      toolSep: {
        width: '1px', height: '16px', background: C.border, opacity: 0.65,
        flex: '0 0 auto', margin: '0 2px',
      },
      toggleOn: {
        padding: '5px 12px', borderRadius: '6px', border: '1px solid ' + C.accent,
        background: 'transparent', color: C.accent, fontSize: '12px', fontWeight: 600,
        cursor: 'pointer', whiteSpace: 'nowrap',
      },
      toggleOff: {
        padding: '5px 12px', borderRadius: '6px', border: '1px solid ' + C.border,
        background: 'transparent', color: C.dim, fontSize: '12px',
        cursor: 'pointer', whiteSpace: 'nowrap',
      },
      status: {
        fontSize: '11px', color: C.dim,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%',
      },
      floatOn: {
        position: 'absolute', top: '10px', left: '10px', zIndex: 30,
        padding: '5px 10px', borderRadius: '999px', border: '1px solid ' + C.accent,
        background: C.elevated, color: C.accent, fontSize: '11px', fontWeight: 600,
        cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
      },
      floatOff: {
        position: 'absolute', top: '10px', left: '10px', zIndex: 30,
        padding: '5px 10px', borderRadius: '999px', border: '1px solid ' + C.border,
        background: C.elevated, color: C.dim, fontSize: '11px', fontWeight: 600,
        cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
      },
      floatZoomBar: {
        position: 'absolute', right: '10px', bottom: '10px', zIndex: 30,
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '3px 5px', borderRadius: '999px',
        background: C.elevated, border: '1px solid ' + C.border,
        boxShadow: '0 4px 14px rgba(0,0,0,0.28)',
      },
      floatZoomBtn: {
        padding: '2px 6px', borderRadius: '999px', border: 'none',
        background: 'transparent', color: C.text, fontSize: '11px',
        cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: '16px',
      },
      ctxDivider: {
        height: '1px', background: C.border, opacity: 0.65, margin: '3px 4px',
      },
      canvasWrap: {
        position: 'relative', flex: '1 1 auto', minHeight: '0',
        display: 'flex', flexDirection: 'column',
      },
      moreBar: { position: 'relative', flex: '0 0 auto' },
      moreMenu: {
        position: 'absolute', right: 0, top: '100%', marginTop: '4px', minWidth: '190px',
        background: C.elevated, color: C.text, border: '1px solid ' + C.border, borderRadius: '6px',
        zIndex: 80, padding: '4px', boxShadow: '0 10px 26px rgba(0,0,0,0.28)',
      },
      moreRow: {
        padding: '5px 8px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer',
        whiteSpace: 'nowrap', color: C.text,
      },
      addMenu: {
        position: 'absolute', minWidth: '164px',
        background: C.elevated, color: C.text, border: '1px solid ' + C.border, borderRadius: '7px',
        zIndex: 85, padding: '4px', boxShadow: '0 12px 30px rgba(0,0,0,0.28)',
      },
      addMenuHead: {
        padding: '4px 8px 3px', fontSize: '10px', color: C.dim,
        borderBottom: '1px solid ' + C.border, marginBottom: '3px',
      },
      addMenuRow: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
        padding: '5px 8px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer',
        color: C.text, whiteSpace: 'nowrap',
      },
      addMenuRowDisabled: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
        padding: '5px 8px', borderRadius: '4px', fontSize: '11px', cursor: 'not-allowed',
        color: C.dim, opacity: 0.45, whiteSpace: 'nowrap',
      },
      addMenuHint: { fontSize: '10px', color: C.dim },
      helpOverlay: {
        position: 'absolute', inset: '0', background: 'rgba(0,0,0,0.45)', zIndex: 90,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px',
      },
      helpCard: {
        width: '100%', maxWidth: '420px', maxHeight: '100%', overflow: 'auto',
        background: C.elevated, color: C.text, border: '1px solid ' + C.border, borderRadius: '8px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.32)', padding: '12px',
      },
      helpHead: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' },
      helpTitle: { flex: '1 1 auto', fontSize: '13px', fontWeight: 600, color: C.text },
      helpBody: { fontSize: '11px', lineHeight: '17px', color: C.dim },
      helpLine: { whiteSpace: 'pre-wrap' },
      shortcutRow: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
        padding: '6px 2px', borderBottom: '1px solid ' + C.border, fontSize: '11px', color: C.text,
      },
      shortcutKeyBtn: {
        minWidth: '88px', padding: '3px 8px', borderRadius: '5px',
        border: '1px solid ' + C.border, background: C.base, color: C.text,
        fontSize: '11px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        cursor: 'pointer', textAlign: 'center', outline: 'none', whiteSpace: 'nowrap',
      },
      shortcutKeyRec: {
        borderColor: C.accent, background: C.hover, color: C.accent, fontWeight: 600,
      },
      presetBar: {
        marginLeft: 'auto', display: 'flex', alignItems: 'center',
        gap: '6px', position: 'relative', flex: '0 0 auto',
      },
      presetRowTop: { display: 'flex', alignItems: 'center', gap: '5px' },
      presetMenu: {
        position: 'absolute', right: 0, top: '100%', marginTop: '4px', minWidth: '236px',
        maxHeight: '320px', overflowY: 'auto', background: C.elevated, color: C.text,
        border: '1px solid ' + C.border, borderRadius: '6px', zIndex: 60, padding: '6px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
      },
      presetSaveBox: {
        padding: '2px 2px 8px', marginBottom: '6px',
        borderBottom: '1px solid ' + C.border,
      },
      presetSaveTitle: { fontSize: '10px', color: C.dim, marginBottom: '5px' },
      presetSaveRow: { display: 'flex', alignItems: 'center', gap: '5px' },
      presetRow: {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 6px',
        borderRadius: '4px', fontSize: '11px', cursor: 'pointer',
      },
      presetRowText: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      presetDel: {
        flex: '0 0 auto', padding: '0 4px', borderRadius: '3px', border: 'none',
        background: 'transparent', color: '#e5534b', fontSize: '11px', cursor: 'pointer',
      },
      presetInput: {
        flex: '1 1 auto', minWidth: '0', padding: '4px 7px', borderRadius: '5px', border: '1px solid ' + C.border,
        background: C.base, color: C.text, fontSize: '11px', outline: 'none', userSelect: 'text',
      },
      presetEmpty: { padding: '6px', fontSize: '10px', color: C.dim },
      syncNote: { fontSize: '10px', color: C.dim, maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      canvas: { position: 'relative', flex: '1 1 auto', overflow: 'hidden', minHeight: '0', userSelect: 'none' },
      content: { position: 'absolute', left: 0, top: 0, width: CONTENT_W, height: CONTENT_H },

      node: {
        position: 'absolute', width: NODE_W, height: NODE_H, boxSizing: 'border-box',
        borderRadius: '10px', border: '1px solid ' + C.border,
        background: C.raised, color: C.text, cursor: 'grab',
        boxShadow: '0 2px 8px rgba(0,0,0,0.22)',
      },
      nodeSel: { border: '2px solid ' + C.accent, boxShadow: '0 4px 18px rgba(47,129,247,0.22)' },
      leadNode: {},
      orphanNode: { border: '1px dashed ' + C.dim, opacity: 0.65 },
      nodeHeader: {
        position: 'absolute', left: 0, right: 0, top: '4px', height: '26px',
        background: 'rgba(128,128,128,0.07)',
        borderBottom: '1px solid rgba(128,128,128,0.18)',
        pointerEvents: 'none', zIndex: 1,
      },
      bandDivider: {
        position: 'absolute', left: '10px', right: '10px', top: (SOCKET_BAND_TOP - 3) + 'px',
        height: '1px', background: 'rgba(128,128,128,0.18)', pointerEvents: 'none', zIndex: 1,
      },

      title: {
        position: 'absolute', left: '10px', right: '62px', top: '8px', height: '18px',
        fontWeight: 600, fontSize: '12px', lineHeight: '18px',
        border: 'none', background: 'transparent', color: C.text, padding: 0, margin: 0,
        outline: 'none', boxSizing: 'border-box', userSelect: 'text', zIndex: 2,
      },
      titleReadonly: {
        position: 'absolute', left: '10px', right: '62px', top: '8px', height: '18px',
        fontWeight: 600, fontSize: '12px', lineHeight: '18px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', zIndex: 2,
      },
      topBar: {
        position: 'absolute', left: 0, right: 0, top: 0, height: '4px',
        borderRadius: '10px 10px 0 0', zIndex: 2, pointerEvents: 'none',
      },
      statusChip: {
        position: 'absolute', left: '10px', bottom: '5px', fontSize: '10px', lineHeight: '14px',
        padding: '1px 6px', borderRadius: '999px',
        color: C.dim, pointerEvents: 'none', zIndex: 3, whiteSpace: 'nowrap',
        display: 'inline-flex', alignItems: 'center', gap: '3px',
      },
      warnChip: {
        position: 'absolute', left: '10px', bottom: '5px', fontSize: '9px', lineHeight: '13px',
        padding: '1px 6px', borderRadius: '999px',
        color: '#d29922', background: 'rgba(210,153,34,0.14)', border: '1px solid rgba(210,153,34,0.55)',
        pointerEvents: 'auto', zIndex: 5, whiteSpace: 'nowrap',
        display: 'inline-flex', alignItems: 'center', gap: '2px',
      },
      statusBtn: {
        position: 'absolute', left: '10px', bottom: '4px', fontSize: '10px', lineHeight: '14px',
        padding: '1px 6px', borderRadius: '999px', border: '1px solid ' + C.border,
        background: C.elevated, color: C.text, cursor: 'pointer', pointerEvents: 'auto',
        zIndex: 7, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '3px',
        outline: 'none', fontWeight: 500,
      },

      fieldModel: { position: 'absolute', left: '10px', right: '10px', top: '35px', height: '22px', display: 'flex', alignItems: 'center', gap: '6px' },
      fieldReason: { position: 'absolute', left: '10px', right: '10px', top: '57px', height: '22px', display: 'flex', alignItems: 'center', gap: '6px' },
      fieldScope: { position: 'absolute', left: '10px', right: '10px', top: '79px', height: '22px', display: 'flex', alignItems: 'center', gap: '6px' },
      fieldFallback: { position: 'absolute', left: '10px', right: '10px', top: '101px', height: '22px', display: 'flex', alignItems: 'center', gap: '6px' },
      fieldMemory: { position: 'absolute', left: '10px', right: '10px', top: '123px', height: '22px', display: 'flex', alignItems: 'center', gap: '6px' },
      fieldRole: { position: 'absolute', left: '10px', right: '10px', top: '145px', height: '22px', display: 'flex', alignItems: 'center', gap: '6px' },
      fieldRoleTop: { position: 'absolute', left: '10px', right: '10px', top: '34px', height: '24px', display: 'flex', alignItems: 'center', gap: '6px' },
      optRow: {
        position: 'absolute', left: '10px', right: '10px', top: '114px', height: '18px',
        display: 'flex', alignItems: 'center', gap: '5px', fontSize: '9px', color: C.dim,
        overflow: 'hidden',
      },

      toggleSwitch: {
        flex: '1 1 auto', width: '100%', height: '18px', boxSizing: 'border-box', padding: '0 5px', borderRadius: '4px',
        border: '1px solid ' + C.border, background: C.base, color: C.text,
        fontSize: '10px', cursor: 'pointer', outline: 'none', textAlign: 'center', lineHeight: '14px',
      },
      toggleSwitchOn: {
        flex: '1 1 auto', width: '100%', height: '18px', boxSizing: 'border-box', padding: '0 5px', borderRadius: '4px',
        border: '1px solid ' + C.accent, background: C.base, color: C.accent,
        fontSize: '10px', cursor: 'pointer', outline: 'none', textAlign: 'center', lineHeight: '14px',
      },
      optChip: {
        flex: '0 0 auto', padding: '2px 6px', borderRadius: '4px',
        border: '1px solid ' + C.border, background: 'transparent', color: C.dim,
        fontSize: '9px', cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: '12px',
        outline: 'none',
      },
      optChipOn: {
        flex: '0 0 auto', padding: '2px 6px', borderRadius: '4px',
        border: '1px solid ' + C.accent, background: C.hover, color: C.accent,
        fontSize: '9px', cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: '12px',
        outline: 'none',
      },
      fieldLabel: { flex: '0 0 30px', width: '30px', fontSize: '9px', color: C.dim, whiteSpace: 'nowrap' },
      fieldLabelEn: { flex: '0 0 46px', width: '46px', fontSize: '9px', color: C.dim, whiteSpace: 'nowrap' },

      input: {
        flex: '1 1 auto', minWidth: '0', padding: '3px 6px', borderRadius: '5px',
        border: '1px solid ' + C.border, background: C.base, color: C.text, fontSize: '12px',
        outline: 'none', userSelect: 'text',
      },
      rolePopover: {
        position: 'absolute', left: '100%', top: '0', marginLeft: '8px', width: '280px',
        background: C.elevated, color: C.text, border: '1px solid ' + C.border, borderRadius: '8px',
        boxShadow: '0 10px 26px rgba(0,0,0,0.28)', padding: '8px', zIndex: 70,
      },
      roleArea: {
        width: '100%', height: '150px', boxSizing: 'border-box', resize: 'vertical',
        background: C.base, color: C.text, fontSize: '11px', lineHeight: '16px',
        border: '1px solid ' + C.border, borderRadius: '5px', padding: '6px 7px',
        outline: 'none', userSelect: 'text',
      },
      leadLabel: {
        position: 'absolute', left: '10px', right: '10px', top: '34px', height: '16px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      },
      task: {
        position: 'absolute', left: '10px', right: '10px', top: '51px', height: '116px',
        padding: '4px 6px', borderRadius: '5px', border: '1px solid ' + C.border,
        background: C.base, color: C.text, fontSize: '11px', resize: 'none', outline: 'none',
        lineHeight: '14px', boxSizing: 'border-box', userSelect: 'text',
      },
      condLabelRow: {
        position: 'absolute', left: '10px', right: '10px', top: '103px', height: '16px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px',
      },
      condBtnGroup: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
      condAddBtn: {
        padding: '0 5px', height: '16px', borderRadius: '4px',
        border: '1px solid ' + C.border, background: C.base, color: C.dim,
        fontSize: '9px', lineHeight: '14px', cursor: 'pointer', outline: 'none',
      },
      condModeBtnOn: {
        padding: '0 5px', height: '16px', borderRadius: '4px',
        border: '1px solid ' + C.accent, background: C.hover, color: C.accent,
        fontSize: '9px', lineHeight: '14px', cursor: 'pointer', outline: 'none',
      },
      condArea: {
        position: 'absolute', left: '10px', right: '10px', top: '121px', height: '46px',
        padding: '4px 6px', borderRadius: '5px', border: '1px solid ' + C.border,
        background: C.base, color: C.text, fontSize: '11px', resize: 'none', outline: 'none',
        lineHeight: '14px', boxSizing: 'border-box', userSelect: 'text',
      },
      condBranchRow: {
        position: 'relative', height: COND_ROW_H + 'px',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      },
      condBranchInput: {
        width: '108px', height: '16px', boxSizing: 'border-box',
        padding: '0 4px', borderRadius: '3px',
        border: '1px solid ' + C.border, background: C.base, color: C.text,
        fontSize: '10px', lineHeight: '14px', textAlign: 'right',
        outline: 'none', userSelect: 'text',
      },
      condBranchExpand: {
        width: '15px', height: '16px', padding: 0, marginRight: '2px',
        border: '1px solid ' + C.border, borderRadius: '3px',
        background: C.base, color: C.dim,
        fontSize: '9px', lineHeight: '14px', cursor: 'pointer', flex: '0 0 auto',
      },
      condBranchDel: {
        width: '14px', height: '16px', padding: 0, marginLeft: '2px',
        border: 'none', background: 'transparent', color: C.dim,
        fontSize: '11px', lineHeight: '14px', cursor: 'pointer', flex: '0 0 auto',
      },
      condBranchDelSpacer: {
        width: '14px', height: '16px', marginLeft: '2px', flex: '0 0 auto',
      },

      selectBtn: {
        flex: '1 1 auto', minWidth: '0', width: '100%', height: '18px', boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', gap: '4px',
        padding: '0 5px', borderRadius: '4px', border: '1px solid ' + C.border,
        background: C.base, color: C.text, fontSize: '10px', cursor: 'pointer', textAlign: 'left',
        lineHeight: '14px',
      },
      reasonChip: {
        flex: '0 0 auto', maxWidth: '44px', padding: '3px 4px', borderRadius: '5px',
        border: '1px solid ' + C.border, background: 'transparent', color: C.dim,
        fontSize: '9px', cursor: 'pointer', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
      },
      selectText: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      caret: { flex: '0 0 auto', color: C.dim, fontSize: '9px' },
      menu: {
        position: 'absolute', left: 0, right: 0, top: '100%', marginTop: '4px',
        maxHeight: '220px', overflowY: 'auto', background: C.elevated, color: C.text,
        border: '1px solid ' + C.border, borderRadius: '6px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.28)', zIndex: 50, padding: '4px',
      },
      menuRow: {
        padding: '3px 7px', borderRadius: '4px', fontSize: '10px', cursor: 'pointer',
        color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      menuHead: { padding: '6px 8px 2px', fontSize: '10px', color: C.dim, textTransform: 'uppercase', letterSpacing: '0.04em' },

      band: { position: 'absolute', left: 0, right: 0, top: SOCKET_BAND_TOP + 'px' },
      row: { position: 'relative', height: ROW_H + 'px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      rowLabel: { fontSize: '9px', color: C.dim, letterSpacing: '0.02em' },
      socket: {
        position: 'absolute', top: (ROW_H - PORT) / 2, width: PORT, height: PORT,
        borderRadius: '50%', background: C.raised, border: '2px solid ' + C.border,
        boxSizing: 'border-box', cursor: 'crosshair', zIndex: 6,
        padding: 0, margin: 0, boxShadow: '0 0 0 3px transparent',
      },
      nodeDelete: {
        position: 'absolute', right: '-8px', top: '-8px', width: '18px', height: '18px',
        borderRadius: '50%', background: C.elevated, border: '1px solid ' + C.border,
        color: '#e5534b', fontSize: '12px', lineHeight: '16px', textAlign: 'center',
        cursor: 'pointer', zIndex: 8, userSelect: 'none',
      },
      runsBadge: {
        position: 'absolute', right: '10px', bottom: '2px', fontSize: '9px',
        color: C.accent, cursor: 'pointer', userSelect: 'none', zIndex: 4,
      },
      statusBar: {
        position: 'absolute', left: '2px', top: '10px', bottom: '10px', width: '3px',
        borderRadius: '2px', zIndex: 3,
      },
      verdictChip: {
        position: 'absolute', left: '0', top: 'calc(100% + 5px)', maxWidth: NODE_W + 'px',
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '2px 8px', borderRadius: '999px', fontSize: '10px', lineHeight: '14px',
        background: C.elevated, border: '1px solid ' + C.border, color: C.text,
        cursor: 'pointer', userSelect: 'none', zIndex: 12,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        boxShadow: '0 4px 12px rgba(0,0,0,0.32)',
      },
      verdictPopover: {
        position: 'absolute', left: '0', top: 'calc(100% + 28px)', width: '272px',
        background: C.elevated, border: '1px solid ' + C.border, borderRadius: '8px',
        padding: '9px 10px', zIndex: 65, boxShadow: '0 14px 32px rgba(0,0,0,0.52)',
        color: C.text, fontSize: '11px', lineHeight: '1.5', userSelect: 'text',
      },
      refsPopover: {
        position: 'absolute', left: '100%', top: '0', marginLeft: '8px', width: '268px',
        background: C.elevated, color: C.text, border: '1px solid ' + C.border, borderRadius: '8px',
        padding: '8px 9px', zIndex: 72, boxShadow: '0 12px 28px rgba(0,0,0,0.34)',
      },
      refsRow: {
        display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '5px',
      },
      refsInput: {
        flex: '1 1 auto', minWidth: 0, height: '22px', boxSizing: 'border-box',
        padding: '0 6px', borderRadius: '4px', border: '1px solid ' + C.border,
        background: C.base, color: C.text, fontSize: '10px', outline: 'none', userSelect: 'text',
      },
    };

    let hostCtx = null;
    let cachedModels = [];

    function normalizeRefsUI(rawRefs) {
      if (!Array.isArray(rawRefs) || !rawRefs.length) return [];
      const out = [];
      const seen = new Set();
      for (const r of rawRefs) {
        if (out.length >= 16) break;
        const s = typeof r === 'string' ? r.trim() : '';
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
      return out;
    }

    /**
     * Clamp a floating context menu inside the canvas wrap, flipping left/up when near the
     * right or bottom edge so menu items never clip off narrow sidebars.
     */
    function clampMenuPos(cx, cy, wrapW, wrapH, menuW, menuH) {
      const pad = 8;
      const sx = (cx + menuW > wrapW - pad)
        ? Math.max(pad, cx - menuW)
        : Math.max(pad, Math.min(wrapW - menuW - pad, cx));
      const sy = (cy + menuH > wrapH - pad)
        ? Math.max(pad, cy - menuH)
        : Math.max(pad, Math.min(wrapH - menuH - pad, cy));
      return { sx, sy };
    }

    /**
     * Clone all selected non-entry nodes and every internal edge connecting two cloned nodes,
     * preserving edge type and condition branch while isolating mutable array fields.
     */
    function cloneSelection(nodes, edges, selectedIds, stampOverride) {
      const selSet = new Set((selectedIds || []).filter((id) => id !== 'lead'));
      const sources = (nodes || []).filter((n) => n && selSet.has(n.id));
      if (!sources.length) return { clones: [], clonedEdges: [] };
      const stamp = stampOverride || Date.now().toString(36);
      const idMap = new Map();
      const clones = sources.map((src, idx) => {
        const { runs: _runs, ...rest } = src;
        const newId = 'n' + stamp + '_' + idx + Math.random().toString(36).slice(2, 4);
        idMap.set(src.id, newId);
        const clone = {
          ...rest,
          id: newId,
          x: (src.x || 0) + 28,
          y: (src.y || 0) + 28,
        };
        if (Array.isArray(src.refs)) clone.refs = src.refs.slice();
        if (Array.isArray(src.branches)) clone.branches = src.branches.map((b) => ({ ...b }));
        return clone;
      });
      const clonedEdges = [];
      let edgeIdx = 0;
      for (const e of edges || []) {
        if (!e || !idMap.has(e.from) || !idMap.has(e.to)) continue;
        const nextEdge = {
          ...e,
          id: 'e' + stamp + '_' + (edgeIdx++) + Math.random().toString(36).slice(2, 4),
          from: idMap.get(e.from),
          to: idMap.get(e.to),
        };
        clonedEdges.push(nextEdge);
      }
      return { clones, clonedEdges };
    }

    /** Compute the next node selection when clicking `id` (Shift/Ctrl toggles membership). */
    function nextSelectionOnNodeClick(selectedIds, id, additive) {
      const cur = Array.isArray(selectedIds) ? selectedIds : [];
      if (additive) {
        if (cur.includes(id)) return { next: cur.filter((x) => x !== id), toggledOff: true };
        return { next: cur.concat([id]), toggledOff: false };
      }
      return { next: cur.includes(id) ? cur : [id], toggledOff: false };
    }

    function socketCenterY(i) {
      return SOCKET_BAND_TOP + i * ROW_H + ROW_H / 2;
    }

    /**
     * Determine which node kinds can legally receive a wire dragged out from `fromNode`.
     * All non-entry targets (agent, lead, condition) are valid, including Lead -> Lead stage chains.
     */
    function compatibleTargetsForWire(_fromNode, _edgeType) {
      return {
        agent: true,
        lead: true,
        condition: true,
        leadBlockedReason: '',
      };
    }

    /** Format a compact verdict pill for a condition node decision snapshot. */
    function conditionVerdictSummary(decision, lang) {
      if (!decision || typeof decision !== 'object') return null;
      const en = lang === 'en';
      if (decision.failed) {
        return {
          tone: 'failed',
          text: '⚠ ' + (en ? 'Judge failed' : '判定失败')
            + (decision.fallbackLead ? ' → ' + decision.fallbackLead : ''),
        };
      }
      const labels = Array.isArray(decision.branchLabels) && decision.branchLabels.length
        ? decision.branchLabels
        : (Array.isArray(decision.branches) ? decision.branches : []);
      if (!labels.length) {
        return {
          tone: 'warn',
          text: '⚠ ' + (en ? 'No match' : '未命中')
            + (decision.fallbackLead ? ' → ' + decision.fallbackLead : ''),
        };
      }
      return {
        tone: 'ok',
        text: '→ ' + labels.join(' · '),
      };
    }

    /** Compute the Entry Lead "▶ Run" button state, label, disabled flag, and tooltip. */
    function entryRunButtonState({ enabled, task, sessionRunning, waitingLead, triggering, lang }) {
      const en = lang === 'en';
      if (sessionRunning || triggering) {
        return {
          state: 'running',
          disabled: true,
          label: en ? 'Running…' : '进行中…',
          title: en
            ? 'Workflow is currently running; wait for this turn to finish'
            : '工作流正在运行中，请等待本轮结束',
        };
      }
      if (waitingLead) {
        const wName = typeof waitingLead === 'object' && waitingLead && waitingLead.label
          ? waitingLead.label
          : '';
        return {
          state: 'waiting',
          disabled: true,
          label: en ? '⏸ Awaiting Lead' : '⏸ 等待决策',
          title: en
            ? 'Paused at intermediate Lead' + (wName ? ' "' + wName + '"' : '') + '; reply in chat to continue'
            : '当前停在中间 Lead' + (wName ? '「' + wName + '」' : '') + '，请先在聊天室回复拍板继续',
        };
      }
      if (!enabled) {
        return {
          state: 'disabled',
          disabled: true,
          label: en ? '▶ Run' : '▶ 运行',
          title: en
            ? 'Turn on ● ON in the top-left corner to enable this canvas first'
            : '请先点亮左上角 ● ON 启用画布',
        };
      }
      if (!String(task || '').trim()) {
        return {
          state: 'disabled',
          disabled: true,
          label: en ? '▶ Run' : '▶ 运行',
          title: en
            ? 'Fill in the Entry Lead task before running to avoid an empty run'
            : '请先在入口节点填写任务内容，避免空跑',
        };
      }
      return {
        state: 'ready',
        disabled: false,
        label: en ? '▶ Run' : '▶ 运行',
        title: en
          ? 'Start the enabled workflow directly (auto-syncs unsaved edits). For retryFailed, reset, or clearing node memory, specify in chat.'
          : '直接按当前画布起跑（会自动同步未保存改动）。如需断点续跑（retryFailed）、从头重跑（reset）或清理记忆节点，可在聊天中说明。',
      };
    }

    function isCustomBranches(node) {
      return Boolean(node && node.kind === 'condition' && Array.isArray(node.branches) && node.branches.length >= 2);
    }

    function conditionBranchesForUI(node, lang) {
      if (isCustomBranches(node)) {
        return node.branches.slice(0, 16).map((item, idx) => {
          const id = typeof item === 'string'
            ? (item.trim() || ('case_' + (idx + 1)))
            : (String((item && (item.id || item.label)) || ('case_' + (idx + 1))).trim());
          const label = typeof item === 'string'
            ? (item.trim() || (lang === 'en' ? 'Case ' + (idx + 1) : '分支 ' + (idx + 1)))
            : (item && item.label !== undefined ? String(item.label) : String((item && item.id) || ''));
          return { id, label, color: BRANCH_COLORS[idx % BRANCH_COLORS.length], custom: true };
        });
      }
      return [
        { id: 'true', label: lang === 'en' ? 'Yes' : '是', color: '#3fb950', custom: false },
        { id: 'false', label: lang === 'en' ? 'No' : '否', color: '#e5534b', custom: false },
      ];
    }

    function nodeHeight(node) {
      if (node && node.kind === 'condition') {
        const count = isCustomBranches(node) ? Math.min(16, node.branches.length) : 2;
        return Math.max(NODE_H, SOCKET_BAND_TOP + count * COND_ROW_H + 24);
      }
      return NODE_H;
    }

    function outputSocketY(fromNode, type, branch) {
      const b = typeof branch === 'string' ? branch.trim() : '';
      if (b || (fromNode && fromNode.kind === 'condition')) {
        const list = conditionBranchesForUI(fromNode);
        const idx = b ? Math.max(0, list.findIndex((x) => x.id === b)) : 0;
        return SOCKET_BAND_TOP + idx * COND_ROW_H + COND_ROW_H / 2;
      }
      const idx = Math.max(0, SOCKET_TYPES.findIndex((t) => t.id === (type || 'prompt')));
      return socketCenterY(idx);
    }

    function outputSocketX(fromNode, type, branch) {
      const b = typeof branch === 'string' ? branch.trim() : '';
      if (b || (fromNode && fromNode.kind === 'condition')) {
        const list = conditionBranchesForUI(fromNode);
        const idx = b ? Math.max(0, list.findIndex((x) => x.id === b)) : 0;
        return Math.round(((idx + 1) / (list.length + 1)) * NODE_W);
      }
      const idx = Math.max(0, SOCKET_TYPES.findIndex((t) => t.id === (type || 'prompt')));
      return Math.round(((idx + 1) / (SOCKET_TYPES.length + 1)) * NODE_W);
    }

    function inputSocketPos(node, direction) {
      if (direction === 'tb') return { x: node.x + NODE_W / 2, y: node.y };
      return { x: node.x, y: node.y + socketCenterY(0, node) };
    }

    function outputSocketPos(fromNode, type, branch, direction) {
      if (direction === 'tb') {
        const b = typeof branch === 'string' ? branch.trim() : '';
        if (b || (fromNode && fromNode.kind === 'condition')) {
          const onLeft = Boolean(fromNode && fromNode.tbSide === 'left');
          return {
            x: onLeft ? fromNode.x : (fromNode.x + NODE_W),
            y: fromNode.y + outputSocketY(fromNode, type, b),
          };
        }
        return { x: fromNode.x + outputSocketX(fromNode, type, branch), y: fromNode.y + nodeHeight(fromNode) };
      }
      return { x: fromNode.x + NODE_W, y: fromNode.y + outputSocketY(fromNode, type, branch) };
    }

    function edgeColorFor(fromNode, edge) {
      const b = edge && typeof edge.branch === 'string' ? edge.branch.trim() : '';
      if (b) {
        if (fromNode && fromNode.kind === 'condition') {
          const hit = conditionBranchesForUI(fromNode).find((x) => x.id === b);
          if (hit) return hit.color;
        }
        if (b === 'true') return '#3fb950';
        if (b === 'false') return '#e5534b';
        return '#2f81f7';
      }
      return (SOCKET_TYPES.find((sock) => sock.id === (edge && edge.type)) || SOCKET_TYPES[0]).color;
    }

    function defaultNodes() {
      return [
        { id: 'lead', kind: 'lead', x: 40, y: 80, label: 'Lead', task: '', provider: '', model: '', role: '' },
        { id: 'n1', kind: 'agent', x: 340, y: 80, label: pick('步骤 1：分析', 'Step 1: Analyze'), provider: '', model: '', role: pick('拆解任务并给出思路', 'Break down the task and propose an approach') },
        { id: 'n2', kind: 'agent', x: 640, y: 80, label: pick('步骤 2：执行', 'Step 2: Execute'), provider: '', model: '', role: pick('按上游思路完成输出', 'Execute the plan from upstream') },
      ];
    }

    function defaultEdges() {
      return [
        { id: 'e-lead-n1', from: 'lead', to: 'n1', type: 'prompt' },
        { id: 'e-n1-n2', from: 'n1', to: 'n2', type: 'prompt' },
      ];
    }

    /**
     * Older docs used an `output` node as the exit. Its meaning is now "another
     * lead step", so migrate the kind instead of dropping the user's graph.
     */
    function ensureEntry(doc) {
      if (!doc || !Array.isArray(doc.nodes)) return doc;
      for (const n of doc.nodes) {
        if (!n) continue;
        if (n.kind === 'output') {
          n.kind = 'lead';
          if (!n.label || n.label === '输出') n.label = 'Lead';
        } else if (!n.kind) {
          n.kind = n.id === 'lead' ? 'lead' : 'agent';
        }
      }
      if (!doc.nodes.some((n) => n && n.id === 'lead')) {
        doc.nodes.unshift({ id: 'lead', kind: 'lead', x: 30, y: 30, label: 'Lead', task: '', provider: '', model: '', role: '' });
      }
      for (const n of doc.nodes) {
        if (n && n.id === 'lead') n.kind = 'lead';
      }
      return doc;
    }

    /** Control points of one link, in canvas coordinates. Supports horizontal (lr) and vertical (tb) flow. */
    function edgeCurve(from, to, typeOrEdge, direction) {
      const type = (typeOrEdge && typeof typeOrEdge === 'object') ? (typeOrEdge.type || 'prompt') : (typeOrEdge || 'prompt');
      const branch = (typeOrEdge && typeof typeOrEdge === 'object') ? (typeOrEdge.branch || '') : '';
      if (direction === 'tb') {
        const isCondOut = Boolean(branch || (from && from.kind === 'condition'));
        if (isCondOut) {
          const onLeft = Boolean(from && from.tbSide === 'left');
          const x1 = from.x + WORLD_PAD + (onLeft ? 0 : NODE_W);
          const y1 = from.y + WORLD_PAD + outputSocketY(from, type, branch);
          const x2 = to.x + WORLD_PAD + NODE_W / 2;
          const y2 = to.y + WORLD_PAD;
          const outSpan = Math.max(46, Math.abs(x2 - x1) * 0.35);
          const dy = Math.max(46, Math.abs(y2 - y1) * 0.45);
          return {
            x1, y1,
            c1x: onLeft ? (x1 - outSpan) : (x1 + outSpan),
            c1y: y1,
            c2x: x2,
            c2y: y2 - dy,
            x2, y2,
          };
        }
        const x1 = from.x + WORLD_PAD + outputSocketX(from, type, branch);
        const y1 = from.y + WORLD_PAD + nodeHeight(from);
        const x2 = to.x + WORLD_PAD + NODE_W / 2;
        const y2 = to.y + WORLD_PAD;
        const dy = Math.max(40, Math.abs(y2 - y1) * 0.5);
        return { x1, y1, c1x: x1, c1y: y1 + dy, c2x: x2, c2y: y2 - dy, x2, y2 };
      }
      const x1 = from.x + WORLD_PAD + NODE_W;
      const y1 = from.y + WORLD_PAD + outputSocketY(from, type, branch);
      const x2 = to.x + WORLD_PAD;
      const y2 = to.y + WORLD_PAD + socketCenterY(0, to);
      const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
      return { x1, y1, c1x: x1 + dx, c1y: y1, c2x: x2 - dx, c2y: y2, x2, y2 };
    }

    function edgePath(from, to, typeOrEdge, direction) {
      const c = edgeCurve(from, to, typeOrEdge, direction);
      return 'M ' + c.x1 + ' ' + c.y1 + ' C ' + c.c1x + ' ' + c.c1y + ', ' + c.c2x + ' ' + c.c2y + ', ' + c.x2 + ' ' + c.y2;
    }

    /** Shortest distance between a point and one link, sampled along the curve. */
    function distanceToEdge(point, from, to, typeOrEdge, direction) {
      const c = edgeCurve(from, to, typeOrEdge, direction);
      let best = Infinity;
      let prevX = c.x1;
      let prevY = c.y1;
      for (let i = 1; i <= 18; i += 1) {
        const t = i / 18;
        const u = 1 - t;
        const bx = u * u * u * c.x1 + 3 * u * u * t * c.c1x + 3 * u * t * t * c.c2x + t * t * t * c.x2;
        const by = u * u * u * c.y1 + 3 * u * u * t * c.c1y + 3 * u * t * t * c.c2y + t * t * t * c.y2;
        best = Math.min(best, distanceToSegment(point, prevX, prevY, bx, by));
        prevX = bx;
        prevY = by;
      }
      return best;
    }

    function distanceToSegment(p, ax, ay, bx, by) {
      const vx = bx - ax;
      const vy = by - ay;
      const len = vx * vx + vy * vy;
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - ax) * vx + (p.y - ay) * vy) / len));
      const dx = p.x - (ax + t * vx);
      const dy = p.y - (ay + t * vy);
      return Math.hypot(dx, dy);
    }

    function topoOrder(nodes, edges) {
      const indeg = new Map(nodes.map((n) => [n.id, 0]));
      const adj = new Map(nodes.map((n) => [n.id, []]));
      for (const e of edges) {
        if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
        indeg.set(e.to, indeg.get(e.to) + 1);
        adj.get(e.from).push(e.to);
      }
      const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
      const out = [];
      while (queue.length) {
        const id = queue.shift();
        out.push(id);
        for (const next of adj.get(id)) {
          indeg.set(next, indeg.get(next) - 1);
          if (indeg.get(next) === 0) queue.push(next);
        }
      }
      return out.length === nodes.length ? out : null;
    }

    /** Ids reachable from the entry Lead via O(V + E) BFS; every other node is skipped at run time. */
    function reachableFrom(nodes, edges) {
      const adj = new Map();
      for (const e of edges || []) {
        if (!e || !e.from || !e.to) continue;
        if (!adj.has(e.from)) adj.set(e.from, []);
        adj.get(e.from).push(e.to);
      }
      const set = new Set(['lead']);
      const queue = ['lead'];
      for (let i = 0; i < queue.length; i += 1) {
        const cur = queue[i];
        for (const next of adj.get(cur) || []) {
          if (!set.has(next)) { set.add(next); queue.push(next); }
        }
      }
      return set;
    }

    /**
     * Reachable non-entry Lead nodes that have zero reachable subagent upstream
     * AND an empty `role` (blank placeholders). Filling a `role` turns them into
     * active main-conversation stage gates (Lead -> Lead chaining).
     */
    function soloLeadNodeIds(nodes, edges) {
      const list = Array.isArray(nodes) ? nodes : [];
      const linkList = Array.isArray(edges) ? edges : [];
      const reachable = reachableFrom(list, linkList);
      const byId = new Map(list.map((n) => [n.id, n]));
      const out = new Set();
      for (const n of list) {
        if (n.kind !== 'lead' || n.id === 'lead' || !reachable.has(n.id)) continue;
        const hasAgentUp = linkList.some((e) => {
          if (!e || e.to !== n.id || !reachable.has(e.from) || e.from === 'lead') return false;
          const src = byId.get(e.from);
          return Boolean(src && src.kind !== 'lead');
        });
        const hasRole = Boolean(String(n.role || '').trim());
        if (!hasAgentUp && !hasRole) out.add(n.id);
      }
      return out;
    }

    /**
     * Reachable agent nodes with zero outgoing edges when the graph has at least
     * one active downstream Lead that is NOT an ancestor of that agent (dangling
     * branch whose output is never consumed). Rendered dashed and skipped at run time.
     */
    function deadEndNodeIds(nodes, edges) {
      const list = Array.isArray(nodes) ? nodes : [];
      const linkList = Array.isArray(edges) ? edges : [];
      const reachable = reachableFrom(list, linkList);
      const soloLeads = soloLeadNodeIds(list, linkList);
      const downstreamLeads = list.filter((n) => n.kind === 'lead' && n.id !== 'lead' && reachable.has(n.id) && !soloLeads.has(n.id));
      if (!downstreamLeads.length) return new Set();
      const hasOut = new Set(linkList.map((e) => e.from));
      const parents = new Map();
      for (const e of linkList) {
        if (!parents.has(e.to)) parents.set(e.to, []);
        parents.get(e.to).push(e.from);
      }
      const ancestorsOf = (id) => {
        const seen = new Set();
        const stack = [id];
        while (stack.length) {
          const cur = stack.pop();
          for (const p of parents.get(cur) || []) {
            if (!seen.has(p)) { seen.add(p); stack.push(p); }
          }
        }
        return seen;
      };
      const out = new Set();
      for (const n of list) {
        if (n.kind === 'lead' || !reachable.has(n.id) || hasOut.has(n.id)) continue;
        const anc = ancestorsOf(n.id);
        if (downstreamLeads.some((ln) => !anc.has(ln.id))) out.add(n.id);
      }
      return out;
    }

    /** True when adding `fromId -> toId` would create a cycle or point into entry Lead. */
    function wouldCycle(nodes, edges, fromId, toId) {
      if (!fromId || !toId || fromId === toId || toId === 'lead') return true;
      const adj = new Map();
      for (const e of edges || []) {
        if (!adj.has(e.from)) adj.set(e.from, []);
        adj.get(e.from).push(e.to);
      }
      const seen = new Set([toId]);
      const queue = [toId];
      while (queue.length) {
        const cur = queue.shift();
        if (cur === fromId) return true;
        for (const next of adj.get(cur) || []) {
          if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
      return false;
    }

    /** Tidy a DAG into symmetrical left-to-right columns by longest-path depth. */
    function layoutGraph(nodes, edges, direction) {
      const list = Array.isArray(nodes) ? nodes : [];
      const linkList = Array.isArray(edges) ? edges : [];
      if (!list.length) return [];
      const reachable = reachableFrom(list, linkList);
      const depth = new Map(list.map((n) => [n.id, n.id === 'lead' ? 0 : 1]));
      for (let pass = 0; pass < list.length; pass += 1) {
        let changed = false;
        for (const e of linkList) {
          if (!reachable.has(e.from) || !reachable.has(e.to) || e.to === 'lead') continue;
          const next = Math.min(list.length, (depth.get(e.from) || 0) + 1);
          if (next > (depth.get(e.to) || 0)) { depth.set(e.to, next); changed = true; }
        }
        if (!changed) break;
      }
      let maxDepth = 0;
      for (const n of list) {
        if (reachable.has(n.id)) maxDepth = Math.max(maxDepth, depth.get(n.id) || 0);
      }
      const columns = new Map();
      for (const n of list) {
        const col = reachable.has(n.id) ? (depth.get(n.id) || 0) : maxDepth + 1;
        if (!columns.has(col)) columns.set(col, []);
        columns.get(col).push(n);
      }
      const posById = new Map();
      if (direction === 'tb') {
        const COL_PITCH = 292;
        const ROW_GAP = 68;
        const MID_X = 340;
        const layers = Array.from(columns.keys()).sort((a, b) => a - b);
        let cursorY = 40;
        for (const layer of layers) {
          const layerNodes = columns.get(layer).slice().sort((a, b) => (a.x || 0) - (b.x || 0));
          const totalW = (layerNodes.length - 1) * COL_PITCH + NODE_W;
          const startX = Math.round(MID_X - totalW / 2);
          let maxH = NODE_H;
          layerNodes.forEach((n, idx) => {
            posById.set(n.id, { x: startX + idx * COL_PITCH, y: cursorY });
            maxH = Math.max(maxH, nodeHeight(n));
          });
          cursorY += maxH + ROW_GAP;
        }
      } else {
        const COL_PITCH = 300;
        const ROW_PITCH = 262;
        const MID_Y = 320;
        for (const [col, colNodes] of columns.entries()) {
          const ordered = colNodes.slice().sort((a, b) => (a.y || 0) - (b.y || 0));
          const totalH = (ordered.length - 1) * ROW_PITCH + NODE_H;
          const startY = Math.round(MID_Y - totalH / 2);
          ordered.forEach((n, row) => {
            posById.set(n.id, { x: 40 + col * COL_PITCH, y: startY + row * ROW_PITCH });
          });
        }
      }
      return list.map((n) => {
        const p = posById.get(n.id);
        return p ? { ...n, x: p.x, y: p.y } : { ...n };
      });
    }

    /** Starter templates shipped with the plugin so new users can try one click away. */
    function builtinTemplates(lang, direction) {
      const en = lang === 'en';
      const sweNodes = [
        {
          id: 'lead', kind: 'lead', label: 'Lead', y: 0,
          task: en
            ? 'Add a rate-limiting middleware to this service: scan codebase patterns and API constraints in parallel, synthesize a structured change spec, pause for my sign-off, implement core code and tests/docs in parallel, run an independent review, and hand off for final ship check.'
            : '给现有项目新增「请求限流中间件」：先并行摸清代码库结构与接口约束，收敛结构化变更方案，我拍板后并行完成核心实现与单测文档，最后独立审查并交我终审交付。',
          provider: '', model: '', role: '',
        },
        {
          id: 'swe_risk', kind: 'agent', y: 0,
          label: en ? 'Constraints & Risks' : '约束与风险',
          provider: '', model: '', reasoning: '', preset: 'standard', keepSession: false,
          role: en
            ? 'Read-only audit of public APIs, error semantics, config conventions and test gaps; list invariants that must not break.'
            : '只读排查相关接口契约、错误码约定、配置方式与测试覆盖缺口，列出绝不能破坏的边界与不变量（不改文件）。',
        },
        {
          id: 'swe_scan', kind: 'agent', y: 100,
          label: en ? 'Codebase Scan' : '代码库摸底',
          provider: '', model: '', reasoning: '', preset: 'standard', keepSession: true,
          role: en
            ? 'Read-only scan to locate entry points, middleware chain, key symbols and local conventions; output an impacted file map.'
            : '只读定位相关模块入口、中间件链路、关键符号和代码风格约定，输出受影响文件清单（不改文件，保留会话供实现复用）。',
        },
        {
          id: 'swe_spec', kind: 'agent', y: 0,
          label: en ? 'Change Spec' : '变更方案',
          provider: '', model: '', reasoning: '', preset: 'minimal', keepSession: false,
          role: en
            ? 'Pure reasoning: merge both scans into a structured JSON spec { filesToChange, publicApi, edgeCases, testPlan, nonGoals }.'
            : '纯推理收敛两份摸底结果，输出结构化 JSON 方案（含 filesToChange、publicApi、edgeCases、testPlan 与 nonGoals）。',
        },
        {
          id: 'swe_plan_gate', kind: 'lead', y: 0,
          label: en ? 'Lead Sign-Off' : 'Lead 拍板',
          provider: '', model: '',
          role: en
            ? 'Review the structured spec, lock down scope and non-goals, and split file ownership cleanly for parallel implementation.'
            : '评审结构化变更方案，敲定实现边界与不做的事，明确源码与测试/文档的改动范围后放行。',
        },
        {
          id: 'swe_tests', kind: 'agent', y: 0,
          label: en ? 'Tests & Docs' : '单测与文档',
          provider: '', model: '', reasoning: '', preset: 'standard', keepSession: false,
          role: en
            ? 'Edit test files and docs only (never touch source code): write unit/edge-case tests and usage notes matching the signed-off spec.'
            : '仅修改测试文件与使用文档（绝不改业务源码）：按拍板方案补齐边界单测用例与配置说明，确保无写冲突。',
        },
        {
          id: 'swe_impl', kind: 'agent', y: 100,
          label: en ? 'Core Implement' : '核心实现',
          provider: '', model: '', reasoning: '', preset: 'standard', keepSession: true,
          role: en
            ? 'Continue inside the Codebase Scan session: edit source files only to implement the approved spec, run checks, and summarize changed files.'
            : '延续「代码库摸底」热会话直接动手（免重复扫库）：仅修改业务源码落实拍板方案，自测并汇报改动清单。',
        },
        {
          id: 'swe_review', kind: 'agent', y: 0,
          label: en ? 'Code Review' : '独立审查',
          provider: '', model: '', reasoning: '', preset: 'standard', keepSession: false,
          role: en
            ? 'Fresh-context review (do not edit code): run the full test suite, inspect git diff for regressions and edge cases, and output a structured JSON verdict.'
            : '全新上下文独立审查（不改代码）：运行完整测试套件并审查 diff，排查回归风险与边界遗漏，输出结构化审查结论。',
        },
        {
          id: 'swe_ship_gate', kind: 'lead', y: 0,
          label: en ? 'Lead Ship Gate' : 'Lead 终审',
          provider: '', model: '',
          role: en
            ? 'Decide ship vs fix from the review verdict; if minor fixes are needed, message the handed-over Core Implement session directly.'
            : '依据结构化审查结论拍板是否交付；若有小问题，直接通过交接的「核心实现」紫线会话下达就地修复。',
        },
      ];
      const sweEdges = [
        { id: 's1', from: 'lead', to: 'swe_risk', type: 'prompt' },
        { id: 's2', from: 'lead', to: 'swe_scan', type: 'prompt' },
        { id: 's3', from: 'swe_risk', to: 'swe_spec', type: 'prompt' },
        { id: 's4', from: 'swe_scan', to: 'swe_spec', type: 'prompt' },
        { id: 's5', from: 'swe_spec', to: 'swe_plan_gate', type: 'structured' },
        { id: 's6', from: 'swe_plan_gate', to: 'swe_tests', type: 'prompt' },
        { id: 's7', from: 'swe_plan_gate', to: 'swe_impl', type: 'prompt' },
        { id: 's8', from: 'swe_scan', to: 'swe_impl', type: 'session-ref' },
        { id: 's9', from: 'swe_tests', to: 'swe_review', type: 'prompt' },
        { id: 's10', from: 'swe_impl', to: 'swe_review', type: 'prompt' },
        { id: 's11', from: 'swe_review', to: 'swe_ship_gate', type: 'structured' },
        { id: 's12', from: 'swe_impl', to: 'swe_ship_gate', type: 'session-ref' },
      ];
      const prdNodes = [
        { id: 'lead', kind: 'lead', label: 'Lead', task: en ? 'Turn this PRD into an implementation plan: run three parallel researches (competitors, feasibility, cost), synthesize a structured plan, pause for my decision, then build code, docs and a test checklist in parallel before my final review.' : '把这份 PRD 变成可实施方案：先并行做三项调研（竞品、技术可行性、成本），合成一份结构化方案，我拍板后并行产出代码与文档、并按方案生成测试清单，最后我终审。', provider: '', model: '', role: '' },
        { id: 'n_comp', kind: 'agent', label: en ? 'Competitors' : '竞品调研', provider: '', model: '', reasoning: '', preset: 'standard', keepSession: false, role: en ? 'Research how similar products solve this and list key trade-offs.' : '调研同类产品的做法，列出优缺点与差异化机会。' },
        { id: 'n_tech', kind: 'agent', label: en ? 'Feasibility' : '技术可行性', provider: '', model: '', reasoning: '', preset: 'standard', keepSession: true, role: en ? 'Assess whether our current stack can support it and identify key risks.' : '评估现有技术栈能否实现，指出核心难点与依赖。' },
        { id: 'n_cost', kind: 'agent', label: en ? 'Cost Estimate' : '成本估算', provider: '', model: '', reasoning: '', preset: 'minimal', keepSession: false, role: en ? 'Estimate effort, timeline, and external dependencies.' : '估算人力、时间与依赖，给出保守与乐观两档评估。' },
        { id: 'n_synth', kind: 'agent', label: en ? 'Plan Synthesis' : '方案合成', provider: '', model: '', reasoning: '', preset: 'standard', keepSession: false, role: en ? 'Merge the three research inputs into one actionable structured plan with options, steps and risks.' : '合并三份调研为一份可执行的结构化方案（含备选路线、steps 与 risks）。' },
        { id: 'n_decide', kind: 'lead', label: en ? 'Lead Decision' : 'Lead 拍板', provider: '', model: '', role: en ? 'Pick one route from the synthesized plan and define scope & non-goals.' : '从合成方案里选定一条路线，写清实施边界与不做的事。' },
        { id: 'n_tests', kind: 'agent', label: en ? 'Test Checklist' : '测试清单', provider: '', model: '', reasoning: '', preset: 'standard', keepSession: false, role: en ? 'Continue from the synthesized plan and derive acceptance tests covering steps & risks.' : '基于方案中的 steps 与 risks 生成可验证的验收测试清单。' },
        { id: 'n_code', kind: 'agent', label: en ? 'Write Code' : '写代码', provider: '', model: '', reasoning: '', preset: 'standard', keepSession: false, role: en ? 'Implement the core changes following the approved plan.' : '按拍板后的方案实现核心改动并自测。' },
        { id: 'n_docs', kind: 'agent', label: en ? 'Write Docs' : '写文档', provider: '', model: '', reasoning: '', preset: 'standard', keepSession: false, role: en ? 'Write user-facing usage notes and changelog.' : '写使用说明与变更记录，面向使用者而非开发者。' },
        { id: 'n_final', kind: 'lead', label: en ? 'Lead Final Review' : 'Lead 终审', provider: '', model: '', role: en ? 'Verify code, docs and test checklist align with the plan and give a ship/no-ship call.' : '核对代码、文档、测试清单三者是否对齐方案，给出能否交付的结论。' },
      ];
      const prdEdges = [
        { id: 't1', from: 'lead', to: 'n_comp', type: 'prompt' },
        { id: 't2', from: 'lead', to: 'n_tech', type: 'prompt' },
        { id: 't3', from: 'lead', to: 'n_cost', type: 'prompt' },
        { id: 't4', from: 'n_comp', to: 'n_synth', type: 'prompt' },
        { id: 't5', from: 'n_tech', to: 'n_synth', type: 'prompt' },
        { id: 't6', from: 'n_cost', to: 'n_synth', type: 'prompt' },
        { id: 't7', from: 'n_synth', to: 'n_decide', type: 'structured' },
        { id: 't8', from: 'n_synth', to: 'n_tests', type: 'session-ref' },
        { id: 't9', from: 'n_decide', to: 'n_code', type: 'prompt' },
        { id: 't10', from: 'n_decide', to: 'n_docs', type: 'prompt' },
        { id: 't11', from: 'n_code', to: 'n_final', type: 'prompt' },
        { id: 't12', from: 'n_tests', to: 'n_final', type: 'prompt' },
        { id: 't13', from: 'n_docs', to: 'n_final', type: 'prompt' },
      ];
      const abNodes = [
        { id: 'lead', kind: 'lead', label: 'Lead', task: '', provider: '', model: '', role: '' },
        { id: 'n_a', kind: 'agent', label: en ? 'Option A (Safe)' : '方案 A（稳健）', provider: '', model: '', reasoning: '', preset: 'minimal', keepSession: false, role: en ? 'Propose a low-risk, minimal-change solution.' : '提出低风险、改动最小的稳健方案。' },
        { id: 'n_b', kind: 'agent', label: en ? 'Option B (Bold)' : '方案 B（创新）', provider: '', model: '', reasoning: '', preset: 'minimal', keepSession: false, role: en ? 'Propose a high-leverage alternative with better long-term payoff.' : '提出上限更高、长期收益更大的进阶方案。' },
        { id: 'n_pick', kind: 'lead', label: en ? 'Lead Pick' : 'Lead 拍板', provider: '', model: '', role: en ? 'Compare both options and pick the direction to execute.' : '对比两份方案，选定最终路线并补充约束。' },
        { id: 'n_exec', kind: 'agent', label: en ? 'Execute' : '执行落地', provider: '', model: '', reasoning: '', preset: 'standard', keepSession: false, role: en ? 'Deliver the chosen solution end to end.' : '按照拍板路线完成最终交付。' },
        { id: 'n_review', kind: 'lead', label: en ? 'Lead Review' : 'Lead 验收', provider: '', model: '', role: en ? 'Verify the deliverable matches the chosen direction and sign off.' : '核对最终产出是否符合拍板方向，确认无误后交付。' },
      ];
      const abEdges = [
        { id: 'a1', from: 'lead', to: 'n_a', type: 'prompt' },
        { id: 'a2', from: 'lead', to: 'n_b', type: 'prompt' },
        { id: 'a3', from: 'n_a', to: 'n_pick', type: 'prompt' },
        { id: 'a4', from: 'n_b', to: 'n_pick', type: 'prompt' },
        { id: 'a5', from: 'n_pick', to: 'n_exec', type: 'prompt' },
        { id: 'a6', from: 'n_exec', to: 'n_review', type: 'prompt' },
      ];
      const condNodes = [
        {
          id: 'lead', kind: 'lead', label: 'Lead', y: 0,
          task: en
            ? 'Run project tests and checks, then route automatically: if everything passes, draft release notes; if anything fails, diagnose root causes and propose a fix patch before final review.'
            : '先运行项目测试与构建自检，再根据结果自动分流：全部通过则整理发布说明；存在失败则定位根因并给出修复方案，最后由我终审。',
          provider: '', model: '', role: '',
        },
        {
          id: 'c_run', kind: 'agent', y: 0,
          label: en ? 'Run & Verify' : '执行与自检',
          provider: '', model: '', reasoning: '', preset: 'standard', keepSession: false,
          role: en
            ? 'Run tests/checks and report exact pass/fail status, error logs, and affected files.'
            : '执行测试或验证命令，如实汇报通过/失败状态、报错日志与受影响文件。',
        },
        {
          id: 'c_gate', kind: 'condition', y: 0,
          label: en ? 'Checks Passed?' : '是否通过？',
          provider: '', model: '', reasoning: '', preset: 'minimal', keepSession: false,
          role: en
            ? 'Return pass=true if upstream tests/checks all passed with no errors; return pass=false on any failure or incomplete delivery.'
            : '判断上游执行与自检是否全部通过且无报错；全部通过返回 true，存在失败或未完全交付返回 false。',
        },
        {
          id: 'c_yes', kind: 'agent', y: 0,
          label: en ? 'Pass: Draft Release' : '通过：整理交付',
          provider: '', model: '', reasoning: '', preset: 'minimal', keepSession: false,
          role: en
            ? 'Summarize verified changes and draft concise release notes ready to ship.'
            : '汇总已验证的改动内容，起草简洁清晰的发布说明与交付清单。',
        },
        {
          id: 'c_no', kind: 'agent', y: 100,
          label: en ? 'Fail: Diagnose & Fix' : '失败：定位修复',
          provider: '', model: '', reasoning: '', preset: 'standard', keepSession: false,
          role: en
            ? 'Inspect the failure logs, identify root causes, and implement or propose a targeted fix.'
            : '排查失败日志、定位根因，并完成或给出最小范围的修复补丁。',
        },
        {
          id: 'c_final', kind: 'lead', y: 0,
          label: en ? 'Lead Final Review' : 'Lead 终审',
          provider: '', model: '',
          role: en
            ? 'Review the chosen branch outcome and decide whether to ship or re-run.'
            : '查看命中的分支产出，确认可直接交付或安排下一轮修复。',
        },
      ];
      const condEdges = [
        { id: 'cd1', from: 'lead', to: 'c_run', type: 'prompt' },
        { id: 'cd2', from: 'c_run', to: 'c_gate', type: 'prompt' },
        { id: 'cd3', from: 'c_gate', to: 'c_yes', type: 'prompt', branch: 'true' },
        { id: 'cd4', from: 'c_gate', to: 'c_no', type: 'prompt', branch: 'false' },
        { id: 'cd5', from: 'c_yes', to: 'c_final', type: 'prompt' },
        { id: 'cd6', from: 'c_no', to: 'c_final', type: 'prompt' },
      ];
      return [
        {
          id: 'tpl-swe',
          name: en ? 'SWE Delivery: Scan → Sign-Off → Build → Review' : '软件工程：摸底 → 拍板 → 并行实现 → 独立审查',
          nodes: layoutGraph(sweNodes, sweEdges, direction),
          edges: sweEdges,
        },
        {
          id: 'tpl-prd',
          name: en ? 'PRD Research → Decide → Build → Review' : 'PRD 调研 → 拍板 → 并行产出 → 终审',
          nodes: layoutGraph(prdNodes, prdEdges, direction),
          edges: prdEdges,
        },
        {
          id: 'tpl-ab',
          name: en ? 'Parallel Options → Decide → Execute → Review' : '并行方案对比 → 拍板 → 执行 → 验收',
          nodes: layoutGraph(abNodes, abEdges, direction),
          edges: abEdges,
        },
        {
          id: 'tpl-cond',
          name: en ? 'Conditional: Run → Pass/Fail Branch → Review' : '条件分支：执行 → 判断分流 → 终审',
          nodes: layoutGraph(condNodes, condEdges, direction),
          edges: condEdges,
        },
      ];
    }

    /** Everything the Host executor needs; no prompts are pre-rendered here. */
    function buildPlan(nodes, edges, opts) {
      const entry = nodes.find((n) => n.id === 'lead');
      if (!entry) return { error: '缺少入口 Lead 节点' };
      const task = String(entry.task || '').trim();
      const rest = nodes.filter((n) => n.id !== 'lead');
      if (!rest.length) return { error: '画布上还没有可执行的节点' };
      // Unconnected nodes, solo Lead-to-Lead nodes, and dangling dead-end agents
      // are shown dashed on the canvas and skipped at run time.
      const reachableIds = reachableFrom(nodes, edges);
      const soloLeads = soloLeadNodeIds(nodes, edges);
      const deadEnds = deadEndNodeIds(nodes, edges);
      const isInactive = (n) => !reachableIds.has(n.id) || soloLeads.has(n.id) || deadEnds.has(n.id);

      const skipped = rest.filter((n) => isInactive(n));
      const active = rest.filter((n) => !isInactive(n));
      if (!active.length) {
        return { error: '没有从入口 Lead 连通的有效节点，无法执行' };
      }

      const activeIds = new Set(active.map((n) => n.id));
      const planEdges = edges
        .filter((e) => (e.from === 'lead' || activeIds.has(e.from)) && activeIds.has(e.to))
        .map((e) => {
          const item = { from: e.from, to: e.to, type: e.type || 'prompt' };
          const b = typeof e.branch === 'string' ? e.branch.trim() : '';
          if (b) item.branch = b;
          return item;
        });

      const maxParallel = opts && Number.isFinite(Number(opts.maxParallel))
        ? Math.max(1, Math.min(8, Math.floor(Number(opts.maxParallel))))
        : 4;

      const entryRefs = normalizeRefsUI(entry.refs);
      const planOut = {
        task,
        maxParallel,
        skipped: skipped.map((n) => n.label || n.id),
        nodes: active.map((n) => {
          const kind = n.kind === 'lead' ? 'lead' : (n.kind === 'condition' ? 'condition' : 'agent');
          const out = {
            id: n.id,
            kind,
            label: n.label || n.id,
            role: n.role || '',
            provider: n.provider || '',
            model: n.model || '',
            reasoning: n.reasoning || '',
            preset: kind === 'condition' ? 'minimal' : (n.preset === 'minimal' ? 'minimal' : 'standard'),
            keepSession: kind === 'condition' ? false : Boolean(n.keepSession),
            memoryChildId: kind === 'condition' ? '' : (n.memoryChildId || ''),
            // A structured link is the only thing that decides this: no separate switch.
            structured: planEdges.some((e) => e.from === n.id && e.type === 'structured'),
            fallbackModel: n.fallbackModel || '',
            fallbackProvider: n.fallbackProvider || '',
          };
          if (kind === 'condition' && isCustomBranches(n)) {
            out.branches = conditionBranchesForUI(n).map((b) => ({ id: b.id, label: b.label }));
          }
          if (kind === 'condition' && n.multiMatch) {
            out.multiMatch = true;
          }
          const nodeRefs = normalizeRefsUI(n.refs);
          if (nodeRefs.length) out.refs = nodeRefs;
          return out;
        }),
        edges: planEdges,
      };
      if (entryRefs.length) planOut.refs = entryRefs;
      return { plan: planOut };
    }

    function loadCutMode() {
      try {
        return window.localStorage.getItem(STORAGE_PREFIX + 'cut') !== 'off';
      } catch (_e) {
        return true;
      }
    }

    function saveCutMode(on) {
      try {
        window.localStorage.setItem(STORAGE_PREFIX + 'cut', on ? 'on' : 'off');
      } catch (_e) { /* ignore */ }
    }

    function loadEffectLevel() {
      try {
        const saved = window.localStorage.getItem(FX_KEY);
        if (FX_LEVELS.includes(saved)) return saved;
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          return 'minimal';
        }
      } catch (_e) { /* ignore */ }
      return 'standard';
    }

    function saveEffectLevel(level) {
      try {
        if (FX_LEVELS.includes(level)) window.localStorage.setItem(FX_KEY, level);
      } catch (_e) { /* ignore */ }
    }

    function nextEffectLevel(cur) {
      const idx = FX_LEVELS.indexOf(cur);
      return FX_LEVELS[(idx + 1) % FX_LEVELS.length];
    }

    function loadMaxParallel() {
      try {
        const raw = Number(window.localStorage.getItem(PARALLEL_KEY));
        if (Number.isFinite(raw) && raw >= 1 && raw <= 8) return Math.floor(raw);
      } catch (_e) { /* ignore */ }
      return 4;
    }

    function saveMaxParallel(n) {
      try {
        if (Number.isFinite(n) && n >= 1 && n <= 8) window.localStorage.setItem(PARALLEL_KEY, String(Math.floor(n)));
      } catch (_e) { /* ignore */ }
    }

    function nextMaxParallel(cur) {
      const idx = PARALLEL_STEPS.indexOf(Number(cur));
      return PARALLEL_STEPS[(idx + 1) % PARALLEL_STEPS.length];
    }

    /** Canonicalize a shortcut string like "shift+d" or "cmd+z" -> "Shift+D" / "Ctrl+Z". */
    function normalizeShortcut(raw) {
      if (typeof raw !== 'string') return '';
      const trimmed = raw.trim();
      if (!trimmed) return '';
      const parts = trimmed.split('+').map((p) => p.trim()).filter(Boolean);
      let ctrl = false;
      let alt = false;
      let shift = false;
      let key = '';
      for (const p of parts) {
        const low = p.toLowerCase();
        if (low === 'ctrl' || low === 'control' || low === 'cmd' || low === 'meta' || low === 'mod') ctrl = true;
        else if (low === 'alt' || low === 'option') alt = true;
        else if (low === 'shift') shift = true;
        else if (low === 'del' || low === 'delete') key = 'Delete';
        else if (low === 'backspace') key = 'Backspace';
        else if (low === 'space' || p === ' ') key = 'Space';
        else if (low === 'enter' || low === 'return') key = 'Enter';
        else if (low === 'tab') key = 'Tab';
        else if (/^f\d{1,2}$/i.test(p)) key = p.toUpperCase();
        else if (p.length === 1) key = p.toUpperCase();
        else key = p.charAt(0).toUpperCase() + p.slice(1);
      }
      if (!key || key === 'Escape') return '';
      return (ctrl ? 'Ctrl+' : '') + (alt ? 'Alt+' : '') + (shift ? 'Shift+' : '') + key;
    }

    /** Extract a canonical shortcut string from a KeyboardEvent, or null for bare modifiers / Esc. */
    function formatShortcutFromEvent(ev) {
      if (!ev) return null;
      const rawKey = typeof ev.key === 'string' ? ev.key : '';
      if (!rawKey || rawKey === 'Control' || rawKey === 'Shift' || rawKey === 'Alt' || rawKey === 'Meta' || rawKey === 'Escape') {
        return null;
      }
      const code = typeof ev.code === 'string' ? ev.code : '';
      let key = '';
      if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
      else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
      else if (rawKey === ' ') key = 'Space';
      else if (rawKey === 'Delete' || rawKey === 'Backspace' || rawKey === 'Enter' || rawKey === 'Tab') key = rawKey;
      else if (/^F\d{1,2}$/i.test(rawKey)) key = rawKey.toUpperCase();
      else if (rawKey.length === 1) key = rawKey.toUpperCase();
      else key = rawKey;
      const ctrl = Boolean(ev.ctrlKey || ev.metaKey);
      const alt = Boolean(ev.altKey);
      const shift = Boolean(ev.shiftKey);
      return normalizeShortcut((ctrl ? 'Ctrl+' : '') + (alt ? 'Alt+' : '') + (shift ? 'Shift+' : '') + key) || null;
    }

    function matchesShortcut(ev, binding) {
      const target = normalizeShortcut(binding);
      if (!target) return false;
      const actual = formatShortcutFromEvent(ev);
      return Boolean(actual) && actual === target;
    }

    function applyShortcutBinding(map, actionId, combo) {
      const next = { ...DEFAULT_SHORTCUTS, ...(map || {}) };
      const norm = normalizeShortcut(combo);
      let clearedConflict = false;
      if (norm) {
        for (const k of SHORTCUT_ORDER) {
          if (k !== actionId && normalizeShortcut(next[k]) === norm) {
            next[k] = '';
            clearedConflict = true;
          }
        }
      }
      next[actionId] = norm;
      return { next, clearedConflict };
    }

    function loadShortcuts() {
      try {
        const raw = window.localStorage.getItem(SHORTCUTS_KEY);
        if (!raw) return { ...DEFAULT_SHORTCUTS };
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_SHORTCUTS };
        const out = { ...DEFAULT_SHORTCUTS };
        for (const k of SHORTCUT_ORDER) {
          if (k in parsed) out[k] = normalizeShortcut(parsed[k]);
        }
        return out;
      } catch (_e) {
        return { ...DEFAULT_SHORTCUTS };
      }
    }

    function saveShortcuts(map) {
      try {
        window.localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(map));
      } catch (_e) { /* ignore */ }
    }

    /** Pick 'left' or 'right' anchor so a wrapped toolbar dropdown never clips off the pane edge. */
    function dropdownAlign(btnRect, containerRect, menuWidth) {
      if (!btnRect || !containerRect) return 'right';
      const need = Number(menuWidth) || 200;
      const availLeft = btnRect.right - containerRect.left;
      const availRight = containerRect.right - btnRect.left;
      if (availLeft < need && availRight >= availLeft) return 'left';
      return 'right';
    }

    /** Compute the next `{ k, x, y }` keeping the content point under `(mx, my)` fixed. */
    function zoomAroundPoint(cur, mx, my, deltaY, deltaMode) {
      if (!deltaY) return cur;
      let dy = deltaY;
      if (deltaMode === 1) dy *= 32;
      else if (deltaMode === 2) dy *= 300;
      dy = Math.max(-150, Math.min(150, dy));
      const factor = Math.pow(1.0012, -dy);
      const k = Math.min(3, Math.max(0.2, cur.k * factor));
      if (k === cur.k) return cur;
      const lx = (mx - cur.x) / cur.k;
      const ly = (my - cur.y) / cur.k;
      return { k, x: mx - lx * k, y: my - ly * k };
    }

    /** Compute `{ k, x, y }` when scrubbing zoom horizontally by `dx` around `(cx, cy)`. */
    function scrubZoom(startView, cx, cy, dx) {
      const k = Math.min(3, Math.max(0.2, startView.k * Math.pow(1.005, dx)));
      if (k === startView.k) return startView;
      const lx = (cx - startView.x) / startView.k;
      const ly = (cy - startView.y) / startView.k;
      return { k, x: cx - lx * k, y: cy - ly * k };
    }

    function loadPresets() {
      try {
        const raw = window.localStorage.getItem(PRESET_KEY);
        if (!raw) return {};
        const doc = JSON.parse(raw);
        return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
      } catch (_e) {
        return {};
      }
    }

    function savePresets(presets) {
      try {
        window.localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
        return true;
      } catch (_e) {
        return false;
      }
    }

    function storageKey(sessionId) {      return STORAGE_PREFIX + (sessionId || '__global__');
    }

    function loadDoc(sessionId) {
      try {
        const raw = window.localStorage.getItem(storageKey(sessionId));
        if (!raw) return null;
        const doc = JSON.parse(raw);
        if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) return null;
        return ensureEntry(doc);
      } catch (_e) {
        return null;
      }
    }

    function saveDoc(sessionId, doc, stamp) {
      try {
        /** Stamp every local edit so a stale generated canvas cannot overwrite it. */
        const stamped = { ...doc, at: typeof stamp === 'number' ? stamp : Date.now() };
        window.localStorage.setItem(storageKey(sessionId), JSON.stringify(stamped));
      } catch (_e) {
        /* storage unavailable */
      }
    }

    function sessionFace(sessionId) {
      try {
        const sessions = hostCtx && hostCtx.sessions;
        if (!sessions || typeof sessions.binding !== 'function' || !sessionId) return undefined;
        const binding = sessions.binding(sessionId);
        return binding && binding.session;
      } catch (_e) {
        return undefined;
      }
    }

    /**
     * Keeps a rendering failure visible: without this the whole tab renders as
     * an empty box and the reason is lost.
     */
    class CanvasBoundary extends Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        try {
          console.error('[workflow-canvas] render failed', error, info);
        } catch (_e) { /* ignore */ }
      }

      render() {
        const error = this.state.error;
        if (!error) return this.props.children;
        const message = String((error && error.message) || error);
        const stack = String((error && error.stack) || '').slice(0, 900);
      return h('div', {
          style: {
            padding: '12px', fontFamily: 'ui-monospace, monospace', fontSize: '11px',
            color: '#e5534b', whiteSpace: 'pre-wrap', overflow: 'auto', height: '100%',
          },
        }, '画布渲染出错：\n' + message + '\n\n' + stack);
      }
    }

    function WorkflowCanvas(props) {
      const sessionId = props && props.sessionId;
      const stored = useRef(loadDoc(sessionId));
      const initial = stored.current;

      const [nodes, setNodes] = useState(() => (initial ? initial.nodes : defaultNodes()));
      const [edges, setEdges] = useState(() => (initial ? initial.edges : defaultEdges()));
      const [selectedIds, setSelectedIds] = useState([]);
      const [marquee, setMarquee] = useState(null);
      const [dragging, setDragging] = useState(false);
      const [syncNote, setSyncNote] = useState('');
      const [roleEditFor, setRoleEditFor] = useState(null);
      const [menuOpen, setMenuOpen] = useState(false);
      const [menuAlign, setMenuAlign] = useState('right');
      const [presetAlign, setPresetAlign] = useState('right');
      const [helpOpen, setHelpOpen] = useState(false);
      const [shortcuts, setShortcuts] = useState(loadShortcuts);
      const shortcutsRef = useRef(shortcuts);
      shortcutsRef.current = shortcuts;
      const [shortcutsOpen, setShortcutsOpen] = useState(false);
      const [recordingAction, setRecordingAction] = useState(null);
      const [cutMode, setCutMode] = useState(loadCutMode);
      const [fxLevel, setFxLevel] = useState(loadEffectLevel);
      const [maxParallel, setMaxParallel] = useState(loadMaxParallel);
      const maxParallelRef = useRef(maxParallel);
      maxParallelRef.current = maxParallel;
      useEffect(() => { ensureStyles(); }, []);
      const cutRef = useRef(null);
      /** Timestamp of the remote document being applied, so saving it does not bump the clock. */
      const applyStamp = useRef(null);
      const [cutPath, setCutPath] = useState([]);
      const [cutVictims, setCutVictims] = useState([]);
      const cutHits = useRef(new Set());
      const [pending, setPending] = useState(null);
      const [status, setStatus] = useState('');
      const [models, setModels] = useState(() => cachedModels);
      const [modelsLoading, setModelsLoading] = useState(() => cachedModels.length === 0);
      const [openModelFor, setOpenModelFor] = useState(null);
      const [enabled, setEnabled] = useState(() => Boolean(initial && initial.enabled));
      const [direction, setDirection] = useState(() => (initial && initial.direction === 'tb' ? 'tb' : 'lr'));
      const directionRef = useRef(direction);
      directionRef.current = direction;

      const rootElRef = useRef(null);
      const canvasWrapRef = useRef(null);
      const contentRef = useRef(null);
      const canvasElRef = useRef(null);
      const pointerInsideRoot = useRef(false);
      const lastMouseRef = useRef(null);
      const [addMenu, setAddMenu] = useState(null);
      const [ctxMenu, setCtxMenu] = useState(null);
      const rightClickRef = useRef(null);
      const nodeDrag = useRef(null);
      const panDrag = useRef(null);
      const [panning, setPanning] = useState(false);
      const spaceDown = useRef(false);
      const [spaceHeld, setSpaceHeld] = useState(false);
      const statusTimer = useRef(null);
      const dropdownRef = useRef(null);
      const syncTimer = useRef(null);
      const lastSync = useRef('');
      const historyRef = useRef([]);
      const redoRef = useRef([]);
      const [dirty, setDirty] = useState(() => Boolean(initial && initial.enabled));
      const [view, setView] = useState({ k: 1, x: 0, y: 0 });
      const viewRef = useRef(view);
      viewRef.current = view;
      const [statusById, setStatusById] = useState({});
      const [runsById, setRunsById] = useState({});
      const [runState, setRunState] = useState(null);
      const [decisionViewFor, setDecisionViewFor] = useState(null);
      const [refsEditFor, setRefsEditFor] = useState(null);
      const [sessionRunning, setSessionRunning] = useState(false);
      const [runTriggering, setRunTriggering] = useState(false);
      const runTriggeringRef = useRef(false);
      const pendingHandledRef = useRef(false);
      const lastNodePrefsRef = useRef({ provider: '', model: '', reasoning: '', preset: 'standard' });
      const [presets, setPresets] = useState(loadPresets);
      const [presetOpen, setPresetOpen] = useState(null);
      const [presetName, setPresetName] = useState('');
      const [lang, setLang] = useState(loadLang);
      const t = (key) => (I18N[lang] && I18N[lang][key]) || I18N.zh[key] || key;
      const toggleLang = () => {
        const next = lang === 'zh' ? 'en' : 'zh';
        setLang(next);
        try { window.localStorage.setItem(LANG_KEY, next); } catch (_e) { /* ignore */ }
      };
      const nodesRef = useRef(nodes);
      nodesRef.current = nodes;
      const edgesRef = useRef(edges);
      edgesRef.current = edges;
      const selectedIdsRef = useRef(selectedIds);
      selectedIdsRef.current = selectedIds;
      const skipDirtyOnce = useRef(false);
      const staleChildIds = useRef(new Set());

      useEffect(() => {
        const stamp = applyStamp.current;
        applyStamp.current = null;
        saveDoc(sessionId, { nodes, edges, enabled, direction }, stamp === null ? undefined : stamp);
      }, [sessionId, nodes, edges, enabled, direction]);

      // Plan signature excludes visual (x, y) coordinates so dragging nodes does
      // not trigger false "unsaved changes" warnings; `skipDirtyOnce` suppresses
      // the dirty flag when applying a canvas written by the Host itself.
      const planSig = (nextEnabled, curNodes, curEdges, overrideParallel) => {
        const mp = typeof overrideParallel === 'number' ? overrideParallel : maxParallelRef.current;
        const res = buildPlan(curNodes, curEdges, { maxParallel: mp });
        const payload = res.error
          ? { enabled: nextEnabled, error: res.error }
          : { enabled: nextEnabled, plan: res.plan };
        return JSON.stringify(payload);
      };

      // Any structural edit after enabling leaves the Host copy stale,
      // except pure position drags (same plan signature) or updates from Host.
      useEffect(() => {
        if (skipDirtyOnce.current) {
          skipDirtyOnce.current = false;
          return;
        }
        if (!enabled) return;
        const sig = planSig(true, nodes, edges);
        if (lastSync.current && sig === lastSync.current) {
          setDirty(false);
          return;
        }
        setDirty(true);
      }, [nodes, edges]);

      // A disabled canvas shows no run status at all.
      useEffect(() => {
        if (!enabled) setStatusById({});
      }, [enabled]);

      useEffect(() => {
        let alive = true;
        const remote = hostCtx && hostCtx.remote && hostCtx.remote.session;
        if (!remote || typeof remote.modelCatalog !== 'function') {
          setModelsLoading(false);
          return undefined;
        }
        remote.modelCatalog().then((res) => {
          if (!alive || !res || !res.ok) return;
          const flat = [];
          for (const group of (res.value && res.value.groups) || []) {
            for (const model of group.models || []) {
              flat.push({
                provider: group.id,
                providerName: group.name,
                model: model.id,
                modelName: model.name,
                efforts: (model.reasoning && model.reasoning.efforts) || [],
                defaultEffort: model.reasoning && model.reasoning.defaultEffort,
              });
            }
          }
          cachedModels = flat;
          setModels(flat);
        }).catch(() => {}).finally(() => {
          if (alive) setModelsLoading(false);
        });
        return () => { alive = false; };
      }, []);

      useEffect(() => {
        if (!openModelFor) return undefined;
        const onDown = (ev) => {
          if (dropdownRef.current && !dropdownRef.current.contains(ev.target)) setOpenModelFor(null);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [openModelFor]);

      // Publishing costs one visible command row in the conversation, so it only
      // happens when the user enables the canvas, loads a preset/import, clears,
      // or asks for it explicitly.
      const pushPlan = (nextEnabled, overrideNodes, overrideEdges, overrideParallel) => {
        try {
          const face = sessionFace(sessionId);
          if (!face || typeof face.command !== 'function') { flash(t('syncFailed')); return Promise.resolve(false); }
          const curNodes = Array.isArray(overrideNodes) ? overrideNodes : nodesRef.current;
          const curEdges = Array.isArray(overrideEdges) ? overrideEdges : edgesRef.current;
          const sig = planSig(nextEnabled, curNodes, curEdges, overrideParallel);
          if (sig === lastSync.current) { setDirty(false); flash(t('upToDate')); return Promise.resolve(true); }
          const line = '/canvas-sync ' + encodeURIComponent(sig);
          const hasStandardAgent = nextEnabled && curNodes.some((n) => n && n.kind !== 'lead' && (n.preset || 'standard') !== 'minimal');
          return face.command(line).then((ack) => {
            if (ack && ack.ok) {
              lastSync.current = sig;
              setDirty(false);
              setRunState(null);
              setDecisionViewFor(null);
              snapshotStaleCatalog();
              flash(hasStandardAgent ? t('syncedWithStdWarn') : t('syncedToHost'));
              return true;
            }
            flash(t('syncFailed'));
            return false;
          }, () => { flash(t('syncFailed')); return false; });
        } catch (_e) {
          flash(t('syncFailed'));
          return Promise.resolve(false);
        }
      };

      const runFromEntry = async () => {
        if (runTriggeringRef.current || sessionRunning) return;
        const entry = nodesRef.current.find((n) => n.id === 'lead');
        const taskText = String((entry && entry.task) || '').trim();
        const waitingLead = runState
          ? (runState.waitingLead || null)
          : (leadReadyIds.size > 0 ? { id: Array.from(leadReadyIds)[0] } : null);
        const btn = entryRunButtonState({
          enabled,
          task: taskText,
          sessionRunning,
          waitingLead,
          triggering: runTriggeringRef.current,
          lang,
        });
        if (btn.disabled) { flash(btn.title); return; }
        const face = sessionFace(sessionId);
        const canPrompt = Boolean(face && typeof face.prompt === 'function');
        const canConvSend = Boolean(hostCtx && hostCtx.conversation && typeof hostCtx.conversation.send === 'function');
        if (!canPrompt && !canConvSend) { flash(t('runSendUnavailable')); return; }
        runTriggeringRef.current = true;
        setRunTriggering(true);
        let succeeded = false;
        try {
          if (dirty) {
            const ok = await pushPlan(true);
            if (!ok) {
              runTriggeringRef.current = false;
              setRunTriggering(false);
              return;
            }
          }
          const promptText = lang === 'en'
            ? 'Run the enabled workflow canvas for this task:\n' + taskText
            : '按当前已启用的画布执行以下任务：\n' + taskText;
          if (canPrompt) {
            const res = await face.prompt([{ type: 'text', text: promptText }], 'queue');
            if (res && res.ok === false) {
              throw new Error((res.error && res.error.message) || 'prompt failed');
            }
          } else {
            await hostCtx.conversation.send(promptText);
          }
          succeeded = true;
          flash(t('runStarted'));
        } catch (err) {
          flash(t('runFailed') + (err && err.message ? ': ' + String(err.message).slice(0, 60) : ''));
        } finally {
          if (!succeeded) {
            runTriggeringRef.current = false;
            setRunTriggering(false);
          } else {
            setTimeout(() => {
              runTriggeringRef.current = false;
              setRunTriggering(false);
            }, 1200);
          }
        }
      };

      // Sync the moment a user message starts a turn, so this turn's tool call
      // already sees the latest canvas. Falls back to the turn end if the start
      // edge was missed; `dirty` clears on success so only one fires.
      const liveRef = useRef({ enabled, dirty, pushPlan });
      liveRef.current = { enabled, dirty, pushPlan };

      useEffect(() => {
        const face = sessionFace(sessionId);
        if (!face || typeof face.subscribe !== 'function' || typeof face.getSnapshot !== 'function') return undefined;
        let wasRunning = false;
        try { wasRunning = Boolean(face.getSnapshot().running); } catch (_e) { wasRunning = false; }
        const onSnapshot = () => {
          let running = false;
          try { running = Boolean(face.getSnapshot().running); } catch (_e) { running = false; }
          if (running !== wasRunning) {
            const live = liveRef.current;
            if (live.enabled && live.dirty) live.pushPlan(true);
          }
          wasRunning = running;
        };
        let unsub;
        try { unsub = face.subscribe(onSnapshot); } catch (_e) { unsub = undefined; }
        return () => {
          if (typeof unsub === 'function') { try { unsub(); } catch (_e) { /* ignore */ } }
        };
      }, [sessionId]);

      const flash = (msg) => {
        setStatus(msg);
        if (statusTimer.current) clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => setStatus(''), 3200);
      };

      const NODE_MARK = /#([^\s#]+)$/;

      /** Mark existing historical subagent sessions as stale before a fresh run. */
      const snapshotStaleCatalog = () => {
        try {
          const sessions = hostCtx && hostCtx.sessions;
          if (sessions && sessionId) {
            const state = sessions.list.getSnapshot();
            const proj = state && state.projectionsBySession && state.projectionsBySession[sessionId];
            const catalog = proj && proj.values && proj.values.subagentCatalog;
            if (Array.isArray(catalog)) {
              const stale = new Set();
              for (const entry of catalog) {
                if (entry && entry.id) stale.add(entry.id);
              }
              staleChildIds.current = stale;
            }
          }
        } catch (_e) { /* ignore */ }
        setStatusById({});
      };

      const readCatalog = () => {
        try {
          const sessions = hostCtx && hostCtx.sessions;
          if (!sessions || !sessionId) return { status: null, runs: null };
          const state = sessions.list.getSnapshot();
          const proj = state && state.projectionsBySession && state.projectionsBySession[sessionId];
          const catalog = proj && proj.values && proj.values.subagentCatalog;
          if (!Array.isArray(catalog)) return { status: null, runs: null };
          const known = new Set(nodesRef.current.map((n) => n.id));
          const nextStatus = {};
          const nextRuns = {};
          for (const entry of catalog) {
            const label = String(entry.label || entry.name || entry.description || '');
            const m = NODE_MARK.exec(label);
            if (!m || !known.has(m[1])) continue;
            const nodeId = m[1];
            const child = state.byId && state.byId[entry.id];
            const timingProj = state.projectionsBySession && state.projectionsBySession[entry.id];
            const timing = timingProj && timingProj.values && timingProj.values.subagentTiming;
            if (entry.id) {
              const prev = nextRuns[nodeId];
              const prevHistory = prev && Array.isArray(prev.history) ? prev.history : [];
              const exists = prevHistory.some((hItem) => hItem.childId === entry.id);
              const history = exists
                ? prevHistory
                : prevHistory.concat([{ childId: entry.id, label, index: prevHistory.length + 1 }]);
              nextRuns[nodeId] = {
                childId: entry.id,
                label,
                mode: entry.mode || 'continuable',
                count: history.length,
                history,
              };
            }
            if (child && child.running) {
              if (entry.id) staleChildIds.current.delete(entry.id);
              nextStatus[nodeId] = 'running';
            } else if (!entry.id || !staleChildIds.current.has(entry.id)) {
              if (timing && timing.lastTurnCompleted === false) nextStatus[nodeId] = 'failed';
              else nextStatus[nodeId] = 'done';
            }
          }
          return { status: nextStatus, runs: nextRuns };
        } catch (_e) {
          return { status: null, runs: null };
        }
      };

      // Live node status & child session links for subagent nodes only: the
      // catalog lists children by `label#nodeId`. Lead steps run inside the
      // conversation, so the canvas cannot observe them and must not pretend to.
      useEffect(() => {
        staleChildIds.current = new Set();
        const sessions = hostCtx && hostCtx.sessions;
        const face = sessionFace(sessionId);
        if (!sessions || !sessionId || !face || typeof face.subscribe !== 'function') return undefined;
        let timer = null;
        const read = () => {
          const { status: nextStatus, runs: nextRuns } = readCatalog();
          if (nextStatus) setStatusById(nextStatus);
          if (nextRuns) setRunsById(nextRuns);
        };
        const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
        let wasRunning = false;
        try { wasRunning = Boolean(face.getSnapshot().running); } catch (_e) { wasRunning = false; }
        setSessionRunning(wasRunning);
        read();
        if (wasRunning) timer = setInterval(read, 700);
        const onSnapshot = () => {
          let running = false;
          try { running = Boolean(face.getSnapshot().running); } catch (_e) { running = false; }
          const finished = !running && wasRunning;
          wasRunning = running;
          setSessionRunning(running);
          if (running && !timer) { read(); timer = setInterval(read, 700); }
          if (!running && timer) { stop(); read(); }
          if (finished && typeof sessions.refreshProjections === 'function') {
            Promise.resolve(sessions.refreshProjections(sessionId)).then(read, () => {});
          }
        };
        let unsub;
        try { unsub = face.subscribe(onSnapshot); } catch (_e) { unsub = undefined; }
        return () => {
          stop();
          if (typeof unsub === 'function') { try { unsub(); } catch (_e) { /* ignore */ } }
        };
      }, [sessionId]);

      /** Synchronously update `viewRef` and schedule React render so rapid events never read stale state. */
      const commitView = (next) => {
        viewRef.current = next;
        setView(next);
      };

      // Zoom with the wheel, anchored on the cursor: the content point under the
      // pointer stays under it while the scale changes. Also absorbs any browser
      // focus-induced scroll on the hidden-overflow canvas so coordinates never drift.
      useEffect(() => {
        const el = canvasElRef.current;
        if (!el) return undefined;
        const absorbScroll = () => {
          if (el.scrollLeft === 0 && el.scrollTop === 0) return;
          const sx = el.scrollLeft;
          const sy = el.scrollTop;
          el.scrollLeft = 0;
          el.scrollTop = 0;
          const cur = viewRef.current;
          commitView({ k: cur.k, x: cur.x - sx, y: cur.y - sy });
        };
        const findScrollableChild = (target, dy) => {
          let node = target instanceof Element ? target : null;
          while (node && node !== el) {
            const overflowY = window.getComputedStyle ? window.getComputedStyle(node).overflowY : '';
            const scrollable = (node.tagName === 'TEXTAREA' || overflowY === 'auto' || overflowY === 'scroll')
              && node.scrollHeight > node.clientHeight + 1;
            if (scrollable) {
              const atTop = node.scrollTop <= 0;
              const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
              if ((dy < 0 && !atTop) || (dy > 0 && !atBottom)) return node;
            }
            node = node.parentElement;
          }
          return null;
        };
        const onWheel = (e) => {
          if (!e.deltaY) return;
          if (!e.ctrlKey && findScrollableChild(e.target, e.deltaY)) return;
          e.preventDefault();
          absorbScroll();
          setCtxMenu(null);
          const rect = el.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          const cur = viewRef.current;
          const next = zoomAroundPoint(cur, mx, my, e.deltaY, e.deltaMode);
          if (next !== cur) commitView(next);
        };
        el.addEventListener('scroll', absorbScroll);
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => {
          el.removeEventListener('scroll', absorbScroll);
          el.removeEventListener('wheel', onWheel);
        };
      }, []);

      const pointTo = (e) => {
        const rect = contentRef.current.getBoundingClientRect();
        const k = viewRef.current.k || 1;
        return {
          x: (e.clientX - rect.left) / k - WORLD_PAD,
          y: (e.clientY - rect.top) / k - WORLD_PAD,
        };
      };

      /** Put a world point at the middle of the visible canvas. */
      const centerOn = (wx, wy, nextK) => {
        const el = canvasElRef.current;
        if (!el) return;
        const k = nextK || viewRef.current.k || 1;
        const cw = el.clientWidth || 1;
        const chh = el.clientHeight || 1;
        el.scrollLeft = 0;
        el.scrollTop = 0;
        commitView({
          k,
          x: cw / 2 - (wx + WORLD_PAD) * k,
          y: chh / 2 - (wy + WORLD_PAD) * k,
        });
      };

      /** World coordinate currently sitting in the middle of the viewport. */
      const viewportCenterWorld = () => {
        const el = canvasElRef.current;
        const k = viewRef.current.k || 1;
        const cw = (el && el.clientWidth) || 800;
        const chh = (el && el.clientHeight) || 600;
        return {
          x: (cw / 2 - viewRef.current.x) / k - WORLD_PAD,
          y: (chh / 2 - viewRef.current.y) / k - WORLD_PAD,
        };
      };

      const focusLead = (nextK) => {
        const lead = nodes.find((n) => n.id === 'lead');
        if (!lead) return;
        centerOn(lead.x + NODE_W / 2, lead.y + NODE_H / 2, nextK);
      };

      /** Horizontal drag scrubber on the percentage pill; pure click resets to 100% on Lead. */
      const onZoomPillDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const el = canvasElRef.current;
        const cx = ((el && el.clientWidth) || 800) / 2;
        const cy = ((el && el.clientHeight) || 600) / 2;
        const startX = e.clientX;
        const startView = { ...viewRef.current };
        let moved = false;
        const prevCursor = typeof document !== 'undefined' && document.body ? document.body.style.cursor : '';
        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          if (!moved && Math.abs(dx) < 3) return;
          if (!moved) {
            moved = true;
            if (typeof document !== 'undefined' && document.body) document.body.style.cursor = 'ew-resize';
          }
          commitView(scrubZoom(startView, cx, cy, dx));
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          if (typeof document !== 'undefined' && document.body) document.body.style.cursor = prevCursor;
          if (!moved) focusLead(1);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      };

      /** Zoom and pan so every node sits comfortably inside the viewport. */
      const fitView = (targetNodes) => {
        const el = canvasElRef.current;
        const list = Array.isArray(targetNodes) && targetNodes.length ? targetNodes : nodesRef.current;
        if (!el || !list.length) return;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const n of list) {
          if (!n || typeof n.x !== 'number' || typeof n.y !== 'number') continue;
          if (n.x < minX) minX = n.x;
          if (n.y < minY) minY = n.y;
          if (n.x + NODE_W > maxX) maxX = n.x + NODE_W;
          const nh = nodeHeight(n);
          if (n.y + nh > maxY) maxY = n.y + nh;
        }
        if (!Number.isFinite(minX)) return;
        const cw = el.clientWidth || 1;
        const chh = el.clientHeight || 1;
        const padX = 36;
        const padTop = 44;
        const padBottom = 36;
        const availW = Math.max(80, cw - padX * 2);
        const availH = Math.max(80, chh - padTop - padBottom);
        const bw = Math.max(NODE_W, maxX - minX);
        const bh = Math.max(NODE_H, maxY - minY);
        const k = Math.max(0.2, Math.min(1, Math.min(availW / bw, availH / bh)));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        el.scrollLeft = 0;
        el.scrollTop = 0;
        commitView({
          k,
          x: cw / 2 - (cx + WORLD_PAD) * k,
          y: padTop + (chh - padTop - padBottom) / 2 - (cy + WORLD_PAD) * k,
        });
      };

      // The world origin is padded, so the initial viewport would otherwise show
      // empty space. Fit all nodes into view the first time the pane mounts.
      const didCenter = useRef(false);
      useEffect(() => {
        if (didCenter.current) return;
        if (!nodesRef.current.length) return;
        didCenter.current = true;
        const raf = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(() => fitView(nodesRef.current))
          : setTimeout(() => fitView(nodesRef.current), 0);
        return () => {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
          else clearTimeout(raf);
        };
      }, []);

      // Snapshot before every structural change so a mis-click can be undone/redone.
      const pushSnapshot = () => {
        historyRef.current.push({ nodes: nodesRef.current, edges: edgesRef.current });
        if (historyRef.current.length > 50) historyRef.current.shift();
        redoRef.current = [];
      };

      const undo = () => {
        const prev = historyRef.current.pop();
        if (!prev) { flash(t('undoNone')); return; }
        redoRef.current.push({ nodes: nodesRef.current, edges: edgesRef.current });
        if (redoRef.current.length > 50) redoRef.current.shift();
        setNodes(prev.nodes);
        setEdges(prev.edges);
        setSelectedIds([]);
        flash(t('undoDone'));
      };

      const redo = () => {
        const next = redoRef.current.pop();
        if (!next) { flash(t('redoNone')); return; }
        historyRef.current.push({ nodes: nodesRef.current, edges: edgesRef.current });
        if (historyRef.current.length > 50) historyRef.current.shift();
        setNodes(next.nodes);
        setEdges(next.edges);
        setSelectedIds([]);
        flash(t('redoDone'));
      };

      const openRun = (node, run) => {
        try {
          const sr = hostCtx && hostCtx.sidebarRight;
          if (!sr || typeof sr.openResource !== 'function') { flash(t('cannotOpen')); return; }
          const addr = 'dsh-resource://subagentchat/session/' + encodeURIComponent(run.childId)
            + '?parent=' + encodeURIComponent(sessionId)
            + '&mode=' + encodeURIComponent(run.mode || 'continuable');
          sr.openResource(addr, { kind: 'subagentchat', preferNewPane: true });
        } catch (_e) {
          flash(t('cannotOpen'));
        }
      };

      const openNodeSession = async (node) => {
        let run = runsById[node.id];
        if (!run) {
          const sessions = hostCtx && hostCtx.sessions;
          if (sessions && sessionId && typeof sessions.refreshProjections === 'function') {
            try { await sessions.refreshProjections(sessionId); } catch (_e) { /* ignore */ }
          }
          const { status: nextStatus, runs: nextRuns } = readCatalog();
          if (nextStatus) setStatusById(nextStatus);
          if (nextRuns) {
            setRunsById(nextRuns);
            run = nextRuns[node.id];
          }
        }
        if (!run) { flash(t('cannotOpen')); return; }
        openRun(node, run);
      };

      const addNode = (kind, atWorld, linkFrom) => {
        const normKind = kind === 'lead' ? 'lead' : (kind === 'condition' ? 'condition' : 'agent');
        if (linkFrom && linkFrom.fromId) {
          const srcNode = nodesRef.current.find((n) => n.id === linkFrom.fromId);
          const compat = compatibleTargetsForWire(srcNode, linkFrom.type);
          if ((normKind === 'lead' && !compat.lead)
            || (normKind === 'agent' && !compat.agent)
            || (normKind === 'condition' && !compat.condition)) {
            flash(t(compat.leadBlockedReason || 'leadToLeadBlocked'));
            return;
          }
        }
        pushSnapshot();
        const newId = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
        const prefs = lastNodePrefsRef.current || {};
        setNodes((ns) => {
          const i = ns.length;
          const center = viewportCenterWorld();
          const x = atWorld && typeof atWorld.x === 'number'
            ? (linkFrom ? (directionRef.current === 'tb' ? Math.round(atWorld.x - NODE_W / 2) : Math.round(atWorld.x)) : Math.round(atWorld.x - NODE_W / 2))
            : center.x + 40 + (ns.length % 3) * 30;
          const y = atWorld && typeof atWorld.y === 'number'
            ? (linkFrom ? (directionRef.current === 'tb' ? Math.round(atWorld.y) : Math.round(atWorld.y - socketCenterY(0))) : Math.round(atWorld.y - NODE_H / 2))
            : center.y - NODE_H / 2 + (ns.length % 3) * 40;
          const defaultLabel = normKind === 'lead'
            ? 'Lead 步骤 ' + i
            : (normKind === 'condition' ? (lang === 'en' ? 'Condition ' + i : '条件判断 ' + i) : 'Node ' + i);
          const nextNode = {
            id: newId,
            kind: normKind,
            x,
            y,
            label: defaultLabel,
            provider: normKind === 'lead' ? '' : (prefs.provider || ''),
            model: normKind === 'lead' ? '' : (prefs.model || ''),
            reasoning: normKind === 'lead' ? '' : (prefs.reasoning || ''),
            preset: normKind === 'condition' ? 'minimal' : (prefs.preset || 'standard'),
            role: '',
          };
          return [...ns, nextNode];
        });
        if (linkFrom && linkFrom.fromId) {
          const type = linkFrom.type || 'prompt';
          const b = typeof linkFrom.branch === 'string' ? linkFrom.branch.trim() : '';
          setEdges((es) => {
            const nextEdge = {
              id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
              from: linkFrom.fromId,
              to: newId,
              type,
            };
            if (b) nextEdge.branch = b;
            return [...es, nextEdge];
          });
        }
        setSelectedIds([newId]);
        setAddMenu(null);
        setCtxMenu(null);
      };

      const deleteEdgeById = (edgeId) => {
        pushSnapshot();
        setEdges((es) => es.filter((e) => e.id !== edgeId));
        setCtxMenu(null);
        flash(t('linkCut') + ' ×1');
      };

      const insertNodeOnEdge = (edgeId, kind, atWorld) => {
        const edge = edgesRef.current.find((e) => e.id === edgeId);
        if (!edge) { setCtxMenu(null); return; }
        pushSnapshot();
        const normKind = kind === 'condition' ? 'condition' : 'agent';
        const newId = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
        const prefs = lastNodePrefsRef.current || {};
        setNodes((ns) => {
          const i = ns.length;
          const x = atWorld && typeof atWorld.x === 'number' ? Math.round(atWorld.x - NODE_W / 2) : 200;
          const y = atWorld && typeof atWorld.y === 'number' ? Math.round(atWorld.y - NODE_H / 2) : 140;
          const defaultLabel = normKind === 'condition'
            ? (lang === 'en' ? 'Condition ' + i : '条件判断 ' + i)
            : 'Node ' + i;
          return [...ns, {
            id: newId,
            kind: normKind,
            x,
            y,
            label: defaultLabel,
            provider: prefs.provider || '',
            model: prefs.model || '',
            reasoning: prefs.reasoning || '',
            preset: normKind === 'condition' ? 'minimal' : (prefs.preset || 'standard'),
            role: '',
          }];
        });
        setEdges((es) => {
          const kept = es.filter((e) => e.id !== edgeId);
          const e1 = {
            id: 'e' + Date.now().toString(36) + 'a',
            from: edge.from,
            to: newId,
            type: edge.type || 'prompt',
          };
          if (edge.branch) e1.branch = edge.branch;
          const e2 = {
            id: 'e' + Date.now().toString(36) + 'b',
            from: newId,
            to: edge.to,
            type: 'prompt',
          };
          if (normKind === 'condition') e2.branch = 'true';
          return kept.concat([e1, e2]);
        });
        setSelectedIds([newId]);
        setCtxMenu(null);
      };

      const updateNode = (id, patch) => {
        if (patch && ('provider' in patch || 'model' in patch || 'reasoning' in patch || 'preset' in patch)) {
          const cur = nodesRef.current.find((n) => n.id === id);
          if (cur && cur.kind !== 'lead') {
            const prev = lastNodePrefsRef.current || {};
            lastNodePrefsRef.current = {
              provider: 'provider' in patch ? (patch.provider || '') : prev.provider,
              model: 'model' in patch ? (patch.model || '') : prev.model,
              reasoning: 'reasoning' in patch ? (patch.reasoning || '') : prev.reasoning,
              preset: cur.kind === 'agent' && 'preset' in patch ? (patch.preset || 'standard') : prev.preset,
            };
          }
        }
        setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)));
      };

      const deleteNode = (id) => {
        if (id === 'lead') { flash(t('leadLocked')); return; }
        pushSnapshot();
        setNodes((ns) => ns.filter((n) => n.id !== id));
        setEdges((es) => es.filter((e) => e.from !== id && e.to !== id));
        setSelectedIds([]);
        flash(t('deletedNode'));
      };

      const deleteSelected = () => {
        const curSel = selectedIdsRef.current;
        if (!curSel.length) return;
        const targets = curSel.filter((id) => id !== 'lead');
        if (!targets.length) { flash(t('leadLocked')); return; }
        const drop = new Set(targets);
        pushSnapshot();
        setNodes((ns) => ns.filter((n) => !drop.has(n.id)));
        setEdges((es) => es.filter((e) => !drop.has(e.from) && !drop.has(e.to)));
        setSelectedIds([]);
        flash(targets.length === 1 ? t('deletedNode') : t('deletedNodes') + ' ×' + targets.length);
      };

      const duplicateSelected = () => {
        const { clones, clonedEdges } = cloneSelection(nodesRef.current, edgesRef.current, selectedIdsRef.current);
        if (!clones.length) return;
        pushSnapshot();
        setNodes((ns) => ns.concat(clones));
        if (clonedEdges.length) setEdges((es) => es.concat(clonedEdges));
        setSelectedIds(clones.map((c) => c.id));
        flash(t('duplicatedNodes') + ' ×' + clones.length);
      };

      const autoLayout = (overrideDir) => {
        const curNodes = nodesRef.current;
        const curEdges = edgesRef.current;
        if (!curNodes.length) return;
        const dir = overrideDir || directionRef.current;
        pushSnapshot();
        const next = layoutGraph(curNodes, curEdges, dir);
        setNodes(next);
        setTimeout(() => fitView(next), 0);
        flash(t('layoutDone'));
      };

      const toggleDirection = () => {
        const nextDir = directionRef.current === 'tb' ? 'lr' : 'tb';
        setDirection(nextDir);
        const curNodes = nodesRef.current;
        const curEdges = edgesRef.current;
        if (curNodes.length) {
          pushSnapshot();
          const next = layoutGraph(curNodes, curEdges, nextDir);
          setNodes(next);
          setTimeout(() => fitView(next), 0);
        }
      };

      const clearCanvas = () => {
        const blank = [{ id: 'lead', kind: 'lead', x: 40, y: 203, label: 'Lead', task: '', provider: '', model: '', role: '' }];
        pushSnapshot();
        if (enabled) {
          skipDirtyOnce.current = true;
          setEnabled(false);
          setDirty(false);
          pushPlan(false, blank, []);
        }
        setNodes(blank);
        setEdges([]);
        setSelectedIds([]);
        setRoleEditFor(null);
        setOpenModelFor(null);
        setPresetOpen(null);
        setMenuOpen(false);
        snapshotStaleCatalog();
        setRunsById({});
        setTimeout(() => centerOn(40 + NODE_W / 2, 203 + NODE_H / 2, 1), 0);
        flash(t('clearedCanvas'));
      };

      const exportToClipboard = () => {
        const cleanNodes = nodesRef.current.map((n) => {
          const { runs: _runs, ...rest } = n;
          return rest;
        });
        const text = JSON.stringify({ nodes: cleanNodes, edges: edgesRef.current }, null, 2);
        const fallbackCopy = () => {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand && document.execCommand('copy');
            document.body.removeChild(ta);
            flash(ok ? t('exportOk') : t('exportFail'));
          } catch (_e) {
            flash(t('exportFail'));
          }
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => flash(t('exportOk')), fallbackCopy);
            return;
          }
        } catch (_e) { /* fall through */ }
        fallbackCopy();
      };

      const openAddMenuAtCursor = () => {
        const wrap = canvasWrapRef.current;
        const content = contentRef.current;
        if (!wrap || !content) return;
        const wrapRect = wrap.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const k = viewRef.current.k || 1;
        const mouse = lastMouseRef.current;
        const insideWrap = mouse
          && mouse.clientX >= wrapRect.left && mouse.clientX <= wrapRect.right
          && mouse.clientY >= wrapRect.top && mouse.clientY <= wrapRect.bottom;
        const cx = insideWrap ? mouse.clientX : (wrapRect.left + wrapRect.width / 2);
        const cy = insideWrap ? mouse.clientY : (wrapRect.top + wrapRect.height / 2);
        const sx = Math.max(8, Math.min(wrapRect.width - 176, cx - wrapRect.left));
        const sy = Math.max(8, Math.min(wrapRect.height - 96, cy - wrapRect.top));
        const wx = (cx - contentRect.left) / k - WORLD_PAD;
        const wy = (cy - contentRect.top) / k - WORLD_PAD;
        setAddMenu({ sx, sy, wx, wy });
        setMenuOpen(false);
        setPresetOpen(null);
        setOpenModelFor(null);
      };

      /** Dragging any selected node moves the whole selection together. */
      const onNodeDown = (e, id) => {
        if (e.button === 2) {
          const tag = e.target && e.target.tagName;
          if (tag !== 'INPUT' && tag !== 'TEXTAREA') e.stopPropagation();
          return;
        }
        if (e.button !== 0 || spaceDown.current) return;
        if (!contentRef.current) return;
        const node = nodes.find((n) => n.id === id);
        if (!node) return;
        const p = pointTo(e);
        const additive = Boolean(e.shiftKey || e.ctrlKey || e.metaKey);
        const { next: group, toggledOff } = nextSelectionOnNodeClick(selectedIds, id, additive);
        setSelectedIds(group);
        setOpenModelFor(null);
        setAddMenu(null);
        setCtxMenu(null);
        e.preventDefault();
        e.stopPropagation();
        if (toggledOff) return;
        const origins = group
          .map((nid) => nodes.find((n) => n.id === nid))
          .filter(Boolean)
          .map((n) => ({ id: n.id, x: n.x, y: n.y }));
        nodeDrag.current = { origins, startX: p.x, startY: p.y, moved: false };
        setDragging(true);
      };

      const onNodeContextMenu = (e, node) => {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        e.stopPropagation();
        rightClickRef.current = null;
        const wrap = canvasWrapRef.current;
        if (!wrap) return;
        if (!selectedIdsRef.current.includes(node.id)) setSelectedIds([node.id]);
        const wrapRect = wrap.getBoundingClientRect();
        const pos = clampMenuPos(e.clientX - wrapRect.left, e.clientY - wrapRect.top, wrapRect.width, wrapRect.height, 180, 176);
        const world = pointTo(e);
        setCtxMenu({ kind: 'node', nodeId: node.id, sx: pos.sx, sy: pos.sy, wx: world.x, wy: world.y });
        setAddMenu(null);
        setMenuOpen(false);
        setPresetOpen(null);
        setOpenModelFor(null);
        setRoleEditFor(null);
        setDecisionViewFor(null);
        setRefsEditFor(null);
      };

      const addNodeRef = (node) => {
        const cur = Array.isArray(node.refs) ? node.refs.slice() : [];
        if (cur.length >= 16) return;
        pushSnapshot();
        updateNode(node.id, { refs: cur.concat(['']) });
      };

      const updateNodeRef = (node, idx, text) => {
        const cur = Array.isArray(node.refs) ? node.refs.slice() : [];
        cur[idx] = text;
        updateNode(node.id, { refs: cur });
      };

      const removeNodeRef = (node, idx) => {
        const cur = Array.isArray(node.refs) ? node.refs.slice() : [];
        pushSnapshot();
        cur.splice(idx, 1);
        updateNode(node.id, { refs: cur });
      };

      const addConditionBranch = (node) => {
        const current = isCustomBranches(node)
          ? conditionBranchesForUI(node, lang).map((b) => ({ id: b.id, label: b.label }))
          : [
              { id: 'true', label: lang === 'en' ? 'Yes' : '是' },
              { id: 'false', label: lang === 'en' ? 'No' : '否' },
            ];
        if (current.length >= 16) return;
        pushSnapshot();
        const used = new Set(current.map((b) => b.id));
        let n = current.length + 1;
        while (used.has('case_' + n)) n += 1;
        const next = current.concat([{
          id: 'case_' + n,
          label: lang === 'en' ? 'Case ' + n : '分支 ' + n,
        }]);
        updateNode(node.id, { branches: next });
      };

      const renameConditionBranch = (node, branchId, nextLabel) => {
        const current = isCustomBranches(node)
          ? conditionBranchesForUI(node, lang).map((b) => ({ id: b.id, label: b.label }))
          : [
              { id: 'true', label: lang === 'en' ? 'Yes' : '是' },
              { id: 'false', label: lang === 'en' ? 'No' : '否' },
            ];
        const next = current.map((b) => (b.id === branchId ? { ...b, label: nextLabel } : b));
        updateNode(node.id, { branches: next });
      };

      const removeConditionBranch = (node, branchId) => {
        if (!isCustomBranches(node)) return;
        const current = conditionBranchesForUI(node, lang).map((b) => ({ id: b.id, label: b.label }));
        if (current.length <= 2) return;
        pushSnapshot();
        const next = current.filter((b) => b.id !== branchId);
        updateNode(node.id, { branches: next });
        setEdges((es) => es.filter((e) => !(e.from === node.id && e.branch === branchId)));
      };

      const onOutputDown = (e, id, type, branch) => {
        const node = nodes.find((n) => n.id === id);
        if (!node) return;
        const b = typeof branch === 'string' ? branch.trim() : '';
        const pos = outputSocketPos(node, type, b, directionRef.current);
        const sx = pos.x;
        const sy = pos.y;
        const color = edgeColorFor(node, { type, branch: b });
        setPending({ dir: 'out', fromId: id, type, branch: b, color, sx, sy, x: sx, y: sy });
        setDragging(true);
        e.preventDefault();
        e.stopPropagation();
      };

      /** Release over an output socket: completes a drag that started at the unified left input. */
      const onOutputUp = (e, id, type, branch) => {
        if (!pending || pending.dir !== 'in') return;
        pendingHandledRef.current = true;
        e.preventDefault();
        e.stopPropagation();
        const b = typeof branch === 'string' ? branch.trim() : '';
        const toId = pending.toId;
        if (toId && toId !== id) {
          if (wouldCycle(nodesRef.current, edgesRef.current, id, toId)) {
            flash(t('cycleBlocked'));
          } else {
            pushSnapshot();
            setEdges((es) => {
              if (es.some((x) => x.from === id && x.to === toId && x.type === type && (x.branch || '') === b)) return es;
              const nextEdge = { id: 'e' + Date.now().toString(36), from: id, to: toId, type };
              if (b) nextEdge.branch = b;
              return [...es, nextEdge];
            });
          }
        }
        setPending(null);
        setDragging(false);
      };

      // Unified left input: dragging a connected input detaches the latest wire;
      // dragging a free input starts a reverse wire that adopts whichever right output it drops onto.
      const onInputDown = (e, id) => {
        e.preventDefault();
        e.stopPropagation();
        const incoming = edges.filter((x) => x.to === id);
        const link = incoming[incoming.length - 1];
        if (!link) {
          const node = nodes.find((n) => n.id === id);
          if (!node) return;
          const pos = inputSocketPos(node, directionRef.current);
          const sx = pos.x;
          const sy = pos.y;
          setPending({ dir: 'in', toId: id, type: 'prompt', branch: '', color: '#8a8f98', sx, sy, x: sx, y: sy });
          setDragging(true);
          return;
        }
        pushSnapshot();
        setEdges((es) => es.filter((x) => x.id !== link.id));
        const from = nodes.find((n) => n.id === link.from);
        if (!from) return;
        const b = typeof link.branch === 'string' ? link.branch.trim() : '';
        const linkType = link.type || 'prompt';
        const pos = outputSocketPos(from, linkType, b, directionRef.current);
        const sx = pos.x;
        const sy = pos.y;
        const color = edgeColorFor(from, link);
        setPending({ dir: 'out', fromId: link.from, type: linkType, branch: b, color, sx, sy, x: sx, y: sy });
        setDragging(true);
      };

      const onInputUp = (e, id) => {
        if (!pending || pending.dir !== 'out') return;
        pendingHandledRef.current = true;
        e.preventDefault();
        e.stopPropagation();
        if (pending.fromId !== id) {
          const fromId = pending.fromId;
          const type = pending.type || 'prompt';
          const b = typeof pending.branch === 'string' ? pending.branch.trim() : '';
          if (wouldCycle(nodesRef.current, edgesRef.current, fromId, id)) {
            flash(t('cycleBlocked'));
          } else {
            pushSnapshot();
            setEdges((es) => {
              if (es.some((x) => x.from === fromId && x.to === id && x.type === type && (x.branch || '') === b)) return es;
              const nextEdge = { id: 'e' + Date.now().toString(36), from: fromId, to: id, type };
              if (b) nextEdge.branch = b;
              return [...es, nextEdge];
            });
          }
        }
        setPending(null);
        setDragging(false);
      };

      // Middle-mouse drag (or Space + left-drag) pans the canvas from anywhere inside it.
      useEffect(() => {
        const inside = (ev) => {
          const el = canvasElRef.current;
          return Boolean(el) && ev.target instanceof Node && el.contains(ev.target);
        };
        const isEditable = (target) => {
          if (!target || !(target instanceof HTMLElement)) return false;
          const tag = target.tagName;
          return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
        };
        const onDown = (ev) => {
          if (!inside(ev)) return;
          const wantPan = ev.button === 1 || (ev.button === 0 && spaceDown.current);
          if (!wantPan) return;
          ev.preventDefault();
          ev.stopPropagation();
          try { window.getSelection().removeAllRanges(); } catch (_sel) { /* ignore */ }
          const cur = viewRef.current;
          panDrag.current = { startX: ev.clientX, startY: ev.clientY, originX: cur.x, originY: cur.y };
          setPanning(true);
          setDragging(true);
        };
        const onAuxClick = (ev) => {
          if (ev.button === 1 && inside(ev)) ev.preventDefault();
        };
        const onKeyDown = (ev) => {
          if (ev.code === 'Space' && !isEditable(ev.target)) {
            spaceDown.current = true;
            setSpaceHeld(true);
          }
        };
        const onKeyUp = (ev) => {
          if (ev.code === 'Space') {
            spaceDown.current = false;
            setSpaceHeld(false);
          }
        };
        const onBlur = () => {
          spaceDown.current = false;
          setSpaceHeld(false);
        };
        window.addEventListener('mousedown', onDown, true);
        window.addEventListener('auxclick', onAuxClick, true);
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', onBlur);
        return () => {
          window.removeEventListener('mousedown', onDown, true);
          window.removeEventListener('auxclick', onAuxClick, true);
          window.removeEventListener('keydown', onKeyDown);
          window.removeEventListener('keyup', onKeyUp);
          window.removeEventListener('blur', onBlur);
        };
      }, []);

      // Configurable canvas keyboard shortcuts (defaults: Shift+A, Shift+D, Delete, Ctrl+Z, Esc).
      const keyActionsRef = useRef(null);
      keyActionsRef.current = {
        undo, redo, deleteSelected, duplicateSelected, openAddMenuAtCursor, addNode, fitView, autoLayout, toggleDirection, flash, t,
        addMenu, ctxMenu, roleEditFor, openModelFor, menuOpen, presetOpen, helpOpen, shortcutsOpen, recordingAction, decisionViewFor, refsEditFor,
        setAddMenu, setCtxMenu, setRoleEditFor, setOpenModelFor, setMenuOpen, setPresetOpen, setHelpOpen, setShortcutsOpen, setRecordingAction, setShortcuts, setDecisionViewFor, setRefsEditFor,
      };
      useEffect(() => {
        const isEditable = (target) => {
          if (!target || !(target instanceof HTMLElement)) return false;
          const tag = target.tagName;
          return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
        };
        const onKey = (ev) => {
          const act = keyActionsRef.current;
          if (!act) return;
          if (act.recordingAction) {
            ev.preventDefault();
            ev.stopPropagation();
            if (ev.key === 'Escape') {
              act.setRecordingAction(null);
              return;
            }
            const combo = formatShortcutFromEvent(ev);
            if (!combo) return;
            const { next, clearedConflict } = applyShortcutBinding(shortcutsRef.current, act.recordingAction, combo);
            shortcutsRef.current = next;
            saveShortcuts(next);
            act.setShortcuts(next);
            act.setRecordingAction(null);
            if (clearedConflict) act.flash(act.t('shortcutsConflict'));
            return;
          }
          if (ev.key === 'Escape') {
            if (act.addMenu || act.ctxMenu || act.roleEditFor || act.openModelFor || act.menuOpen || act.presetOpen || act.helpOpen || act.shortcutsOpen || act.decisionViewFor || act.refsEditFor) {
              ev.preventDefault();
              act.setAddMenu(null);
              act.setCtxMenu(null);
              act.setRoleEditFor(null);
              act.setOpenModelFor(null);
              act.setMenuOpen(false);
              act.setPresetOpen(null);
              act.setHelpOpen(false);
              act.setShortcutsOpen(false);
              act.setRecordingAction(null);
              act.setDecisionViewFor(null);
              act.setRefsEditFor(null);
            }
            return;
          }
          if (act.shortcutsOpen) return;
          if (isEditable(ev.target)) return;
          if (act.addMenu) {
            const lf = act.addMenu.linkFrom || null;
            if (ev.key === '1' || ev.key === 'Enter') {
              ev.preventDefault();
              act.addNode('agent', { x: act.addMenu.wx, y: act.addMenu.wy }, lf);
              return;
            }
            if (ev.key === '2') {
              ev.preventDefault();
              act.addNode('lead', { x: act.addMenu.wx, y: act.addMenu.wy }, lf);
              return;
            }
            if (ev.key === '3') {
              ev.preventDefault();
              act.addNode('condition', { x: act.addMenu.wx, y: act.addMenu.wy }, lf);
              return;
            }
          }
          const root = rootElRef.current;
          const activeInRoot = Boolean(root && document.activeElement && root.contains(document.activeElement));
          if (!pointerInsideRoot.current && !activeInRoot) return;
          const sc = shortcutsRef.current || DEFAULT_SHORTCUTS;
          if (matchesShortcut(ev, sc.addNode)) {
            ev.preventDefault();
            act.openAddMenuAtCursor();
            return;
          }
          const allBound = Object.values(sc).map(normalizeShortcut);
          if (matchesShortcut(ev, sc.undo)) {
            ev.preventDefault();
            act.undo();
            return;
          }
          if (matchesShortcut(ev, sc.redo)
            || (normalizeShortcut(sc.redo) === 'Ctrl+Shift+Z' && !allBound.includes('Ctrl+Y') && matchesShortcut(ev, 'Ctrl+Y'))) {
            ev.preventDefault();
            act.redo();
            return;
          }
          if (matchesShortcut(ev, sc.duplicate)) {
            ev.preventDefault();
            act.duplicateSelected();
            return;
          }
          if (matchesShortcut(ev, sc.fitView)) {
            ev.preventDefault();
            act.fitView();
            return;
          }
          if (matchesShortcut(ev, sc.autoLayout)) {
            ev.preventDefault();
            act.autoLayout();
            return;
          }
          if (matchesShortcut(ev, sc.toggleDir)) {
            ev.preventDefault();
            act.toggleDirection();
            return;
          }
          const delHit = matchesShortcut(ev, sc.delete)
            || (normalizeShortcut(sc.delete) === 'Delete' && !allBound.includes('Backspace') && matchesShortcut(ev, 'Backspace'));
          if (delHit) {
            if (selectedIdsRef.current.length) {
              ev.preventDefault();
              act.deleteSelected();
            }
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);

      useEffect(() => {
        if (!dragging) return undefined;
        const move = (ev) => onCanvasMove(ev);
        const up = (ev) => onCanvasUp(ev);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
      }, [dragging, marquee, pending]);

      const onCanvasDown = (e) => {
        if (e.button === 2) {
          e.preventDefault();
          try { window.getSelection().removeAllRanges(); } catch (_sel) { /* ignore */ }
          const start = pointTo(e);
          rightClickRef.current = { clientX: e.clientX, clientY: e.clientY, start, moved: false };
          setDragging(true);
          return;
        }
        if (e.button !== 0) return;
        if (roleEditFor) setRoleEditFor(null);
        if (decisionViewFor) setDecisionViewFor(null);
        if (refsEditFor) setRefsEditFor(null);
        if (menuOpen) setMenuOpen(false);
        if (addMenu) setAddMenu(null);
        if (ctxMenu) setCtxMenu(null);
        if (presetOpen) setPresetOpen(null);
        e.preventDefault();
        try { window.getSelection().removeAllRanges(); } catch (_sel) { /* ignore */ }
        const p = pointTo(e);
        setMarquee({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
        setDragging(true);
        if (selectedIds.length) setSelectedIds([]);
        setOpenModelFor(null);
      };

      const onCanvasMove = (e) => {
        if (panDrag.current) {
          const pan = panDrag.current;
          const dx = e.clientX - pan.startX;
          const dy = e.clientY - pan.startY;
          commitView({ k: viewRef.current.k, x: pan.originX + dx, y: pan.originY + dy });
          return;
        }
        if (rightClickRef.current && !rightClickRef.current.moved) {
          if (Math.hypot(e.clientX - rightClickRef.current.clientX, e.clientY - rightClickRef.current.clientY) >= 6) {
            rightClickRef.current.moved = true;
            if (cutMode) {
              cutRef.current = rightClickRef.current.start;
              cutHits.current = new Set();
              setCutPath([rightClickRef.current.start]);
              setCutVictims([]);
            }
          }
        }
        if (nodeDrag.current) {
          const p = pointTo(e);
          const drag = nodeDrag.current;
          const dx = p.x - drag.startX;
          const dy = p.y - drag.startY;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) drag.moved = true;
          const byId = new Map(drag.origins.map((o) => [o.id, o]));
          setNodes((ns) => ns.map((n) => {
            const origin = byId.get(n.id);
            return origin ? { ...n, x: origin.x + dx, y: origin.y + dy } : n;
          }));
        } else if (cutRef.current) {
          const p = pointTo(e);
          const threshold = 12 / (viewRef.current.k || 1);
          const from = cutRef.current;
          const steps = Math.max(1, Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) / 6));
          const nodeMap = new Map(nodes.map((n) => [n.id, n]));
          for (let step = 1; step <= steps; step += 1) {
            const t = step / steps;
            const canvasSpot = {
              x: from.x + (p.x - from.x) * t + WORLD_PAD,
              y: from.y + (p.y - from.y) * t + WORLD_PAD,
            };
            for (const edge of edges) {
              if (cutHits.current.has(edge.id)) continue;
              const source = nodeMap.get(edge.from);
              const target = nodeMap.get(edge.to);
              if (!source || !target) continue;
              if (distanceToEdge(canvasSpot, source, target, edge, directionRef.current) <= threshold) {
                cutHits.current.add(edge.id);
              }
            }
          }
          setCutPath((path) => path.concat([{ x: p.x, y: p.y }]).slice(-60));
          setCutVictims(Array.from(cutHits.current));
          cutRef.current = p;
        } else if (marquee) {
          const p = pointTo(e);
          const next = { x1: marquee.x1, y1: marquee.y1, x2: p.x, y2: p.y };
          setMarquee(next);
          // Live preview: highlight what the band currently covers.
          setSelectedIds(hitTest(next));
        } else if (pending) {
          const p = pointTo(e);
          setPending((prev) => (prev ? { ...prev, x: p.x, y: p.y } : prev));
        }
      };

      const onCanvasUp = (ev) => {
        if (rightClickRef.current) {
          const rc = rightClickRef.current;
          rightClickRef.current = null;
          if (!rc.moved) {
            const wrap = canvasWrapRef.current;
            if (wrap) {
              const wrapRect = wrap.getBoundingClientRect();
              const cx = rc.clientX - wrapRect.left;
              const cy = rc.clientY - wrapRect.top;
              const canvasSpot = { x: rc.start.x + WORLD_PAD, y: rc.start.y + WORLD_PAD };
              const threshold = Math.max(10, 14 / (viewRef.current.k || 1));
              const nodeMap = new Map(nodesRef.current.map((n) => [n.id, n]));
              let hitEdge = null;
              let bestDist = Infinity;
              for (const edge of edgesRef.current) {
                const source = nodeMap.get(edge.from);
                const target = nodeMap.get(edge.to);
                if (!source || !target) continue;
                const dist = distanceToEdge(canvasSpot, source, target, edge, directionRef.current);
                if (dist <= threshold && dist < bestDist) {
                  bestDist = dist;
                  hitEdge = edge;
                }
              }
              setAddMenu(null);
              setMenuOpen(false);
              setPresetOpen(null);
              setOpenModelFor(null);
              setRoleEditFor(null);
              setDecisionViewFor(null);
              setRefsEditFor(null);
              if (hitEdge) {
                const pos = clampMenuPos(cx, cy, wrapRect.width, wrapRect.height, 180, 120);
                setCtxMenu({ kind: 'edge', edgeId: hitEdge.id, sx: pos.sx, sy: pos.sy, wx: rc.start.x, wy: rc.start.y });
              } else {
                const pos = clampMenuPos(cx, cy, wrapRect.width, wrapRect.height, 186, 322);
                setCtxMenu({ kind: 'canvas', sx: pos.sx, sy: pos.sy, wx: rc.start.x, wy: rc.start.y });
              }
            }
            setDragging(false);
            return;
          }
        }
        if (cutRef.current) {
          cutRef.current = null;
          setDragging(false);
          const victims = Array.from(cutHits.current);
          const victimIds = new Set(victims);
          cutHits.current = new Set();
          if (victims.length) {
            pushSnapshot();
            setEdges((es) => es.filter((x) => !victimIds.has(x.id)));
            flash(t('linkCut') + ' ×' + victims.length);
          }
        }
        if (cutPath.length) { setCutPath([]); setCutVictims([]); }
        if (marquee) {
          setSelectedIds(hitTest(marquee));
          setMarquee(null);
        }
        if (panDrag.current) {
          panDrag.current = null;
          setPanning(false);
        }
        nodeDrag.current = null;
        const handled = pendingHandledRef.current;
        pendingHandledRef.current = false;
        if (!handled && pending && pending.dir === 'out') {
          const dist = Math.hypot(pending.x - pending.sx, pending.y - pending.sy);
          const wrap = canvasWrapRef.current;
          if (dist >= 16 && wrap) {
            const wrapRect = wrap.getBoundingClientRect();
            const cx = ev && typeof ev.clientX === 'number' ? ev.clientX : (wrapRect.left + wrapRect.width / 2);
            const cy = ev && typeof ev.clientY === 'number' ? ev.clientY : (wrapRect.top + wrapRect.height / 2);
            const sx = Math.max(8, Math.min(wrapRect.width - 176, cx - wrapRect.left));
            const sy = Math.max(8, Math.min(wrapRect.height - 110, cy - wrapRect.top));
            setAddMenu({
              sx,
              sy,
              wx: pending.x,
              wy: pending.y,
              linkFrom: {
                fromId: pending.fromId,
                type: pending.type || 'prompt',
                branch: pending.branch || '',
                color: pending.color || '#8a8f98',
                sx: pending.sx,
                sy: pending.sy,
                x: pending.x,
                y: pending.y,
              },
            });
            setMenuOpen(false);
            setPresetOpen(null);
            setOpenModelFor(null);
            setDecisionViewFor(null);
          }
        }
        setPending(null);
        setDragging(false);
      };

      const savePresetNow = () => {
        const name = presetName.trim();
        if (!name) { flash(t('needName')); return; }
        if (Object.prototype.hasOwnProperty.call(presets, name)) {
          flash('"' + name + '" ' + t('dupName'));
          return;
        }
        const next = { ...presets, [name]: { nodes, edges } };
        if (!savePresets(next)) { flash(t('saveFailed')); return; }
        setPresets(next);
        setPresetName('');
        flash(t('savedPreset') + ': ' + name);
      };

      /** Load a canvas document produced by the model. */
      const applyCanvasDoc = (doc, remoteAt, fromRemote) => {
        if (!doc || !Array.isArray(doc.nodes)) return false;
        const merge = doc.mode === 'merge';
        if (!merge && !doc.nodes.length) return false;
        pushSnapshot();
        const stamp = typeof remoteAt === 'number' ? remoteAt : (typeof doc.at === 'number' ? doc.at : null);
        applyStamp.current = stamp;
        if (fromRemote) {
          skipDirtyOnce.current = true;
          setDirty(false);
        }
        if (typeof doc.enabled === 'boolean') {
          setEnabled(doc.enabled);
        }
        const removedNodes = new Set(doc.removeNodes || []);
        const rawIncomingEdges = Array.isArray(doc.edges) ? doc.edges : [];
        setNodes((existing) => {
          const byId = new Map(existing.map((n) => [n.id, n]));
          const placed = new Map(existing.map((n) => [n.id, { x: n.x, y: n.y }]));
          let addedCount = 0;
          const isTB = directionRef.current === 'tb';
          const incoming = doc.nodes.map((n, i) => {
            const prev = byId.get(n.id) || {};
            let x = typeof n.x === 'number' ? n.x : prev.x;
            let y = typeof n.y === 'number' ? n.y : prev.y;
            if (typeof x !== 'number' || typeof y !== 'number') {
              // Place a newly patched node downstream of its first upstream node,
              // respecting the active horizontal (lr) or vertical (tb) flow direction.
              const parentEdge = rawIncomingEdges.find((e) => e && e.to === n.id && placed.has(e.from));
              if (parentEdge) {
                const parentPos = placed.get(parentEdge.from);
                const parentNode = byId.get(parentEdge.from);
                if (isTB) {
                  const targetY = parentPos.y + nodeHeight(parentNode) + 68;
                  const siblingCount = Array.from(placed.values()).filter((p) => Math.abs(p.y - targetY) < 40).length;
                  x = parentPos.x + siblingCount * 292;
                  y = targetY;
                } else {
                  const siblingCount = Array.from(placed.values()).filter((p) => Math.abs(p.x - (parentPos.x + 300)) < 40).length;
                  x = parentPos.x + 300;
                  y = parentPos.y + siblingCount * 240;
                }
              } else {
                const leadPos = placed.get('lead') || { x: 40, y: 80 };
                if (isTB) {
                  x = merge ? leadPos.x + addedCount * 292 : 40 + i * 292;
                  y = merge ? leadPos.y + NODE_H + 68 : 80;
                } else {
                  x = merge ? leadPos.x + 300 : 60 + i * 300;
                  y = merge ? leadPos.y + (addedCount + 1) * 240 : 80;
                }
              }
              addedCount += 1;
            }
            placed.set(n.id, { x, y });
            return { ...prev, ...n, x, y };
          });
          if (!merge) {
            return isTB ? layoutGraph(incoming, rawIncomingEdges, 'tb') : incoming;
          }
          const touched = new Set(incoming.map((n) => n.id));
          const kept = existing
            .filter((n) => !touched.has(n.id) && !removedNodes.has(n.id))
            .map((n) => {
              if (n.id !== 'lead') return n;
              const patch = {};
              if (typeof doc.task === 'string') patch.task = doc.task;
              if (Array.isArray(doc.refs)) patch.refs = doc.refs;
              return Object.keys(patch).length ? { ...n, ...patch } : n;
            });
          return kept.concat(incoming);
        });
        setEdges((existing) => {
          const incoming = rawIncomingEdges.map((e, i) => {
            const item = {
              id: e.id || 'e' + i + '-' + Math.random().toString(36).slice(2, 6),
              from: e.from,
              to: e.to,
              type: e.type || 'prompt',
            };
            const b = typeof e.branch === 'string' ? e.branch.trim() : '';
            if (b) item.branch = b;
            return item;
          });
          if (!merge) return incoming;
          const rawDrops = Array.isArray(doc.removeEdges) ? doc.removeEdges : [];
          const matchesDrop = (e) => rawDrops.some((r) => r
            && String(r.from) === e.from
            && String(r.to) === e.to
            && (!r.type || r.type === e.type)
            && (!r.branch || r.branch === e.branch));
          const kept = existing.filter((e) => !matchesDrop(e) && !removedNodes.has(e.from) && !removedNodes.has(e.to));
          const keyOf = (e) => e.from + '>' + e.to + '|' + e.type + '|' + (e.branch || '');
          const seen = new Set(kept.map(keyOf));
          const added = incoming.filter((e) => !removedNodes.has(e.from) && !removedNodes.has(e.to) && !seen.has(keyOf(e)));
          return kept.concat(added);
        });
        setSelectedIds([]);
        snapshotStaleCatalog();
        if (!merge) {
          setRunsById({});
          setTimeout(() => fitView(nodesRef.current), 0);
        }
        return true;
      };

      // The Host writes generated canvases where the workspace Remote can read
      // them; polling that file is the only Host -> canvas channel available.
      const AUTO_CANVAS = true;
      useEffect(() => {
        if (!AUTO_CANVAS) return undefined;
        let remote;
        try { remote = hostCtx && hostCtx.remote; } catch (_e) { remote = undefined; }
        let wf = resolveWorkspaceFiles(hostCtx);
        if (!wf) {
          try { wf = remote && remote.workspaceFiles; } catch (_e) { wf = undefined; }
        }
        if (!wf || typeof wf.read !== 'function') { setSyncNote(t('syncOff')); return undefined; }
        if (!sessionId) { setSyncNote(t('syncNoSession')); return undefined; }
        // The Host names the file after the agent id (session-<uuid>); the
        // pane prop may carry either form, so try both.
        const bare = String(sessionId).replace(/^session-/, '');
        const paths = [
          '.dsh/canvas/' + String(sessionId) + '.json',
          '.dsh/canvas/session-' + bare + '.json',
          '.dsh/canvas/' + bare + '.json',
        ].filter((v, i, all) => all.indexOf(v) === i);
        const runPaths = [
          '.dsh/canvas/' + String(sessionId) + '.run.json',
          '.dsh/canvas/session-' + bare + '.run.json',
          '.dsh/canvas/' + bare + '.run.json',
        ].filter((v, i, all) => all.indexOf(v) === i);
        setRunState(null);
        setDecisionViewFor(null);
        let alive = true;
        let lastText = '';
        let lastRunText = '';
        const tick = async () => {
          try {
            let text = '';
            for (const path of paths) {
              try {
                const res = await wf.read(sessionId, path, {}, new AbortController().signal);
                if (!alive) return;
                const payload = res && res.ok === false ? null : (res && res.value !== undefined ? res.value : res);
                const read = payload && (typeof payload.text === 'string' ? payload.text : '');
                if (read) { text = read; break; }
              } catch (err) {
                setSyncNote(t('syncReadFail') + String((err && err.message) || err).slice(0, 80));
              }
            }
            if (text && text !== lastText) {
              lastText = text;
              const doc = JSON.parse(text);
              const canvas = doc && doc.canvas;
              // A canvas the user has edited more recently wins over an old file.
              let staleLocal = false;
              try {
                const raw = window.localStorage.getItem(storageKey(sessionId));
                const local = raw ? JSON.parse(raw) : null;
                if (local && typeof local.at === 'number' && typeof doc.at === 'number' && local.at > doc.at) {
                  staleLocal = true;
                }
              } catch (_e) { /* ignore */ }
              if (!staleLocal) {
                const valid = canvas && Array.isArray(canvas.nodes)
                  && (canvas.mode === 'merge' || canvas.nodes.length > 0)
                  && canvas.nodes.every((n) => n && typeof n.id === 'string');
                if (valid && applyCanvasDoc(canvas, doc.at, true)) {
                  flash(t('generated'));
                  setSyncNote(t('syncApplied'));
                  setTimeout(() => setSyncNote(''), 4000);
                }
                else setSyncNote(t('syncBadFile'));
              }
            }
          } catch (_e) { /* file absent or not readable yet */ }
          try {
            let runText = '';
            for (const rp of runPaths) {
              try {
                const res = await wf.read(sessionId, rp, {}, new AbortController().signal);
                if (!alive) return;
                const payload = res && res.ok === false ? null : (res && res.value !== undefined ? res.value : res);
                const read = payload && (typeof payload.text === 'string' ? payload.text : '');
                if (read) { runText = read; break; }
              } catch (_e) { /* ignore */ }
            }
            if (runText && runText !== lastRunText) {
              lastRunText = runText;
              const parsed = JSON.parse(runText);
              if (parsed && typeof parsed === 'object') {
                setRunState(parsed.status === 'idle' ? null : parsed);
              }
            }
          } catch (_e) { /* run state file absent or not readable yet */ }
        };
        const timer = setInterval(tick, 1500);
        tick();
        return () => { alive = false; clearInterval(timer); };
      }, [sessionId]);

      const importFromClipboard = () => {
        const finish = (text) => {
          if (!text) { flash(t('importNone')); return; }
          let doc;
          try {
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            doc = JSON.parse(text.slice(start, end + 1));
          } catch (_e) { flash(t('importBad')); return; }
          if (!applyCanvasDoc(doc.canvas || doc)) { flash(t('importBad')); return; }
          if (enabled) setTimeout(() => pushPlan(true), 0);
          flash(t('importOk') + (doc.canvas || doc).nodes.length);
        };
        try {
          if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then(finish, () => flash(t('importNone')));
            return;
          }
        } catch (_e) { /* fall through */ }
        flash(t('importNone'));
      };

      const applyPreset = (name) => {
        const preset = presets[name];
        if (!preset || !Array.isArray(preset.nodes) || !Array.isArray(preset.edges)) { flash(t('invalidPreset')); return; }
        pushSnapshot();
        if (enabled) {
          skipDirtyOnce.current = true;
          pushPlan(true, preset.nodes, preset.edges);
        }
        setNodes(preset.nodes);
        setEdges(preset.edges);
        setSelectedIds([]);
        snapshotStaleCatalog();
        setRunsById({});
        setPresetOpen(null);
        setTimeout(() => fitView(preset.nodes), 0);
        flash(t('loadedPreset') + ': ' + name);
      };

      const applyTemplate = (tpl) => {
        if (!tpl || !Array.isArray(tpl.nodes) || !Array.isArray(tpl.edges)) return;
        const clonedNodes = tpl.nodes.map((n) => ({ ...n }));
        const clonedEdges = tpl.edges.map((e) => ({ ...e }));
        pushSnapshot();
        if (enabled) {
          skipDirtyOnce.current = true;
          pushPlan(true, clonedNodes, clonedEdges);
        }
        setNodes(clonedNodes);
        setEdges(clonedEdges);
        setSelectedIds([]);
        snapshotStaleCatalog();
        setRunsById({});
        setPresetOpen(null);
        setTimeout(() => fitView(clonedNodes), 0);
        flash(t('loadedPreset') + ': ' + tpl.name);
      };

      const deletePreset = (name) => {
        const next = { ...presets };
        delete next[name];
        savePresets(next);
        setPresets(next);
        flash(t('deletedPreset') + ': ' + name);
      };

      const toggleEnabled = () => {
        const next = !enabled;
        setEnabled(next);
        setDirty(false);
        pushPlan(next);
      };

      const modelValue = (node) => (node.provider ? node.provider + '::' : '') + (node.model || '');
      const modelEntry = (node) => {
        if (!node || !node.model) return undefined;
        if (node.provider) {
          const exact = models.find((m) => m.provider === node.provider && m.model === node.model);
          if (exact) return exact;
        }
        return models.find((m) => m.model === node.model);
      };
      const modelLabel = (node) => {
        const hit = modelEntry(node);
        return hit ? (hit.modelName || hit.model) : (node.model || t('pickModel'));
      };
      // Reasoning ids are adapter-declared per model; '' means "use the model default".
      const reasoningOptions = (node) => {
        const hit = modelEntry(node);
        const ids = ((hit && hit.efforts) || []).map((e) => e.id);
        return ['', ...(ids.length ? ids : REASONING_FALLBACK)];
      };
      const reasoningLabel = (node) => {
        if (!node.reasoning) return t('defaultEffort');
        const hit = modelEntry(node);
        const found = hit && hit.efforts ? hit.efforts.find((e) => e.id === node.reasoning) : undefined;
        return (found && (found.name || found.id)) || node.reasoning;
      };

      const scopeToggle = (node) => {
        const wide = (node.preset || 'standard') !== 'minimal';
        return h('button', {
          style: wide ? S.toggleSwitchOn : S.toggleSwitch,
          type: 'button',
          title: t('tipPreset'),
          onMouseDown: (e) => e.stopPropagation(),
          onClick: () => updateNode(node.id, { preset: wide ? 'minimal' : 'standard' }),
        }, wide ? t('scopeStandard') : t('scopeMinimal'));
      };
      const fallbackControl = (node) => {
        const key = 'f:' + node.id;
        const isOpen = openModelFor === key;
        const current = node.fallbackModel;
        const shown = current
          ? ((node.fallbackProvider && models.find((m) => m.provider === node.fallbackProvider && m.model === current))
            || models.find((m) => m.model === current))
          : undefined;
        const rows = [];
        rows.push(h('div', {
          key: 'none',
          style: current ? S.menuRow : { ...S.menuRow, background: C.hover, color: C.accent },
          onClick: () => { updateNode(node.id, { fallbackModel: '', fallbackProvider: '' }); setOpenModelFor(null); },
        }, t('none')));
        let lastProvider = null;
        for (const m of models) {
          if (m.provider !== lastProvider) {
            rows.push(h('div', { key: 'h-' + m.provider, style: S.menuHead }, m.providerName || m.provider));
            lastProvider = m.provider;
          }
          const picked = shown ? (m.provider === shown.provider && m.model === shown.model) : (m.model === current);
          rows.push(h('div', {
            key: m.provider + '::' + m.model,
            style: picked ? { ...S.menuRow, background: C.hover, color: C.accent } : S.menuRow,
            onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
            onMouseLeave: (e) => { e.currentTarget.style.background = picked ? C.hover : 'transparent'; },
            onClick: () => { updateNode(node.id, { fallbackModel: m.model, fallbackProvider: m.provider }); setOpenModelFor(null); },
          }, m.modelName || m.model));
        }
        if (models.length === 1) {
          rows.push(h('div', { key: 'single-hint', style: S.presetEmpty }, t('singleModelHint')));
        }
      return h('div', { ref: isOpen ? dropdownRef : undefined, style: { position: 'relative', flex: '1 1 auto', minWidth: 0 } },
          h('button', {
            style: S.selectBtn,
            type: 'button',
            title: t('tipFallback'),
            onMouseDown: (e) => e.stopPropagation(),
            onClick: () => setOpenModelFor(isOpen ? null : key),
          },
            h('span', { style: S.selectText }, shown ? (shown.modelName || shown.model) : t('none')),
            h('span', { style: S.caret }, '▾'),
          ),
          isOpen && h('div', { style: S.menu, onMouseDown: (e) => e.stopPropagation() }, rows),
        );
      };
      const memoryToggle = (node) => {
        const runInfo = runsById[node.id];
        const history = (runInfo && Array.isArray(runInfo.history)) ? runInfo.history : [];
        const isOn = Boolean(node.keepSession);
        const key = 'm:' + node.id;
        const isOpen = isOn && openModelFor === key;
        const pickedItem = node.memoryChildId
          ? history.find((item) => item.childId === node.memoryChildId)
          : undefined;
        const pickLabel = !node.memoryChildId
          ? t('memLatest')
          : (pickedItem ? ('#' + pickedItem.index) : String(node.memoryChildId).slice(-6));
        const toggleBtn = h('button', {
          style: isOn ? S.toggleSwitchOn : S.toggleSwitch,
          type: 'button',
          title: t('tipMemory'),
          onMouseDown: (e) => e.stopPropagation(),
          onClick: () => {
            if (isOn && openModelFor === key) setOpenModelFor(null);
            updateNode(node.id, { keepSession: !isOn });
          },
        }, isOn ? t('on') : t('off'));
        const rows = [
          h('div', {
            key: 'latest',
            style: !node.memoryChildId ? { ...S.menuRow, background: C.hover, color: C.accent } : S.menuRow,
            onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
            onMouseLeave: (e) => { e.currentTarget.style.background = !node.memoryChildId ? C.hover : 'transparent'; },
            onClick: () => { updateNode(node.id, { memoryChildId: '' }); setOpenModelFor(null); },
          }, t('memLatestOpt')),
          ...history.map((item) => {
            const selectedRow = node.memoryChildId === item.childId;
      return h('div', {
              key: item.childId,
              style: selectedRow ? { ...S.menuRow, background: C.hover, color: C.accent } : S.menuRow,
              title: item.childId,
              onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
              onMouseLeave: (e) => { e.currentTarget.style.background = selectedRow ? C.hover : 'transparent'; },
              onClick: () => { updateNode(node.id, { memoryChildId: item.childId }); setOpenModelFor(null); },
            }, t('memRunOpt').replace('{n}', String(item.index)) + ' (' + String(item.childId).slice(-5) + ')');
          }),
          !history.length && h('div', { key: 'mem-empty', style: S.presetEmpty }, t('memEmpty')),
        ];
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', flex: '1 1 auto', minWidth: 0 } },
          toggleBtn,
          h('div', { ref: isOpen ? dropdownRef : undefined, style: { position: 'relative', flex: '0 0 64px', width: '64px' } },
            h('button', {
              style: isOn
                ? { ...S.selectBtn, borderColor: C.accent }
                : { ...S.selectBtn, borderColor: C.border, color: C.dim, opacity: 0.55, cursor: 'not-allowed' },
              type: 'button',
              disabled: !isOn,
              title: t('tipMemoryPick'),
              onMouseDown: (e) => e.stopPropagation(),
              onClick: () => { if (isOn) setOpenModelFor(isOpen ? null : key); },
            },
              h('span', { style: S.selectText }, pickLabel),
              h('span', { style: S.caret }, '▾'),
            ),
            isOpen && h('div', {
              style: { ...S.menu, left: 'auto', right: 0, minWidth: '150px' },
              onMouseDown: (e) => e.stopPropagation(),
            }, rows),
          ),
        );
      };

      const reasoningControl = (node) => {
        const key = 'r:' + node.id;
        const isOpen = openModelFor === key;
        const entry = modelEntry(node);
        const labelOf = (id) => {
          if (!id) return t('defaultEffort');
          const found = entry && entry.efforts ? entry.efforts.find((e) => e.id === id) : undefined;
          return (found && (found.name || found.id)) || id;
        };
        const rows = reasoningOptions(node).map((id, i) => h('div', {
          key: 'r' + i,
          style: node.reasoning === id ? { ...S.menuRow, background: C.hover, color: C.accent } : S.menuRow,
          onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
          onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
          onClick: () => { updateNode(node.id, { reasoning: id }); setOpenModelFor(null); },
        }, labelOf(id)));
      return h('div', { ref: isOpen ? dropdownRef : undefined, style: { position: 'relative', flex: '1 1 auto', minWidth: 0 } },
          h('button', {
            style: S.selectBtn,
            type: 'button',
            title: t('tipModel'),
            onMouseDown: (e) => e.stopPropagation(),
            onClick: () => setOpenModelFor(isOpen ? null : key),
          },
            h('span', { style: S.selectText }, labelOf(node.reasoning)),
            h('span', { style: S.caret }, '▾'),
          ),
          isOpen && h('div', { style: S.menu, onMouseDown: (e) => e.stopPropagation() }, rows),
        );
      };

      const modelControl = (node) => {
        if (!models.length) {
          if (modelsLoading) {
            return h('button', {
              type: 'button',
              disabled: true,
              style: { ...S.selectBtn, color: C.dim, cursor: 'default' },
              onMouseDown: (e) => e.stopPropagation(),
            },
              h('span', { style: S.selectText }, node.model || t('loadingModels')),
              h('span', { style: S.caret }, '▾'),
            );
          }
          return h('input', {
            style: S.input,
            value: node.model || '',
            placeholder: 'model id',
            onMouseDown: (e) => e.stopPropagation(),
            onChange: (e) => updateNode(node.id, { model: e.target.value }),
          });
        }
        const current = modelValue(node);
        const matched = modelEntry(node);
        const isOpen = openModelFor === node.id;
        const rows = [];
        let lastProvider = null;
        for (const m of models) {
          if (m.provider !== lastProvider) {
            rows.push(h('div', { key: 'h-' + m.provider, style: S.menuHead }, m.providerName || m.provider));
            lastProvider = m.provider;
          }
          const selectedRow = matched
            ? (m.provider === matched.provider && m.model === matched.model)
            : (m.provider + '::' + m.model === current);
          rows.push(h('div', {
            key: m.provider + '::' + m.model,
            style: selectedRow ? { ...S.menuRow, background: C.hover, color: C.accent } : S.menuRow,
            onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
            onMouseLeave: (e) => { e.currentTarget.style.background = selectedRow ? C.hover : 'transparent'; },
            onClick: () => { updateNode(node.id, { provider: m.provider, model: m.model }); setOpenModelFor(null); },
          }, m.modelName || m.model));
        }
      return h('div', { ref: isOpen ? dropdownRef : undefined, style: { position: 'relative', flex: '1 1 auto', minWidth: 0 } },
          h('button', {
            style: S.selectBtn,
            type: 'button',
            onMouseDown: (e) => e.stopPropagation(),
            onClick: () => setOpenModelFor(isOpen ? null : node.id),
          },
            h('span', { style: S.selectText }, modelLabel(node)),
            h('span', { style: S.caret }, '▾'),
          ),
          isOpen && h('div', {
            style: S.menu,
            onMouseDown: (e) => e.stopPropagation(),
          }, rows),
        );
      };

      const fxName = (level) => (level === 'minimal' ? t('fxMinimal') : (level === 'vivid' ? t('fxVivid') : t('fxStandard')));
      const selectedSet = new Set(selectedIds);
      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      const inColorByNode = new Map();
      const inCountByNode = new Map();
      const inPriority = (e) => (e.type === 'session-ref' ? 3 : (e.type === 'structured' ? 2 : (e.branch ? 1.5 : 1)));
      const inPrioByNode = new Map();
      const connectedOut = new Set();
      for (const e of edges) {
        const type = e.type || 'prompt';
        const b = typeof e.branch === 'string' ? e.branch.trim() : '';
        connectedOut.add(e.from + '|' + (b ? 'branch:' + b : type));
        inCountByNode.set(e.to, (inCountByNode.get(e.to) || 0) + 1);
        const prio = inPriority(e);
        if (!inPrioByNode.has(e.to) || prio >= inPrioByNode.get(e.to)) {
          inPrioByNode.set(e.to, prio);
          inColorByNode.set(e.to, edgeColorFor(nodeById.get(e.from), e));
        }
      }
      const reachableIds = reachableFrom(nodes, edges);
      const soloLeadIds = soloLeadNodeIds(nodes, edges);
      const deadEndIds = deadEndNodeIds(nodes, edges);

      // Lead nodes are never spawned, so their status is derived from graph state:
      // - Intermediate Lead (has downstream): glows "Ready" until any child starts,
      //   then settles to "Done".
      // - Terminal Lead (no downstream): Host finishes in one shot, so it glows only
      //   while the main conversation is still streaming (`sessionRunning`), then
      //   settles to "Done" once the turn ends.
      const leadReadyIds = new Set();
      const leadDoneIds = new Set();
      const hasCondNode = nodes.some((x) => x.kind === 'condition');
      if (enabled) {
        if (runState && runState.waitingLead && runState.waitingLead.id) {
          leadReadyIds.add(runState.waitingLead.id);
        }
        if (runState && Array.isArray(runState.done)) {
          for (const did of runState.done) {
            const dn = nodeById.get(did);
            if (dn && dn.kind === 'lead' && dn.id !== 'lead') leadDoneIds.add(did);
          }
        }
        for (const n of nodes) {
          if (n.kind !== 'lead' || n.id === 'lead' || !reachableIds.has(n.id)) continue;
          if (leadReadyIds.has(n.id) || leadDoneIds.has(n.id)) continue;
          const upIds = edges
            .filter((e) => e.to === n.id && e.from !== 'lead' && nodeById.has(e.from))
            .map((e) => e.from);
          if (!upIds.length) continue;
          const upAgents = upIds.filter((id) => nodeById.get(id).kind !== 'lead');
          if (!upAgents.length) continue;
          const anyUpRunning = upAgents.some((id) => statusById[id] === 'running');
          const allUpDone = hasCondNode
            ? (!anyUpRunning && upAgents.some((id) => statusById[id] === 'done' || statusById[id] === 'failed'))
            : upAgents.every((id) => statusById[id] === 'done' || statusById[id] === 'failed');
          if (!allUpDone) continue;
          const downIds = edges.filter((e) => e.from === n.id).map((e) => e.to);
          if (!downIds.length) {
            if (sessionRunning) leadReadyIds.add(n.id);
            else leadDoneIds.add(n.id);
          } else {
            const anyDownStarted = downIds.some((id) => Boolean(statusById[id]));
            if (!anyDownStarted) leadReadyIds.add(n.id);
            else leadDoneIds.add(n.id);
          }
        }
      }

      const decisionsById = (enabled && runState && runState.decisions && typeof runState.decisions === 'object')
        ? runState.decisions
        : {};
      const prunedSet = new Set(enabled && runState && Array.isArray(runState.pruned) ? runState.pruned : []);
      const blockedEdgeSet = new Set(enabled && runState && Array.isArray(runState.blockedEdges) ? runState.blockedEdges : []);
      const edgeKeyForState = (e) => String(e.from) + '->' + String(e.to) + '|' + String(e.type || 'prompt') + '|' + String(e.branch || '');

      const edgeEls = edges.map((edge) => {
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        if (!from || !to) return null;
        const color = edgeColorFor(from, edge);
        const d = edgePath(from, to, edge, direction);
        const highlighted = cutVictims.includes(edge.id);
        const isPrunedEdge = !highlighted && (blockedEdgeSet.has(edgeKeyForState(edge)) || prunedSet.has(edge.from) || prunedSet.has(edge.to));
        const hasSel = selectedSet.size > 0;
        const linkedToSel = hasSel && (selectedSet.has(edge.from) || selectedSet.has(edge.to));
        const toRunning = enabled && statusById[edge.to] === 'running';
        const fromReady = edge.from === 'lead'
          || from.kind === 'lead'
          || statusById[edge.from] === 'done'
          || statusById[edge.from] === 'failed';
        const isFlowing = enabled && !highlighted && !isPrunedEdge && (
          (toRunning && fromReady)
          || (leadReadyIds.has(edge.to) && (statusById[edge.from] === 'done' || statusById[edge.from] === 'failed'))
        );
        const fromSettled = edge.from === 'lead'
          || statusById[edge.from] === 'done'
          || statusById[edge.from] === 'failed'
          || leadDoneIds.has(edge.from);
        const toSettled = statusById[edge.to] === 'done'
          || statusById[edge.to] === 'running'
          || statusById[edge.to] === 'failed'
          || leadReadyIds.has(edge.to)
          || leadDoneIds.has(edge.to);
        const isCompletedLink = enabled && !highlighted && !isPrunedEdge && fromSettled && toSettled;
        const dimmed = isPrunedEdge || (hasSel && !linkedToSel && !highlighted && !isFlowing);
        const strokeColor = highlighted ? '#e5534b' : color;
        const baseWidth = highlighted ? 3 : (linkedToSel || isFlowing ? 2.6 : 2);
        const baseOpacity = isPrunedEdge ? 0.22 : (dimmed ? 0.26 : (isFlowing || linkedToSel ? 1 : (isCompletedLink ? 0.92 : 0.78)));
        const useGlow = fxLevel === 'vivid' && !dimmed;
        const showDashFlow = isFlowing && fxLevel !== 'minimal';
        const showBead = isFlowing && fxLevel === 'vivid';

        return h('g', { key: edge.id, style: { pointerEvents: 'none' } },
          // Vector halo layers instead of an SVG objectBoundingBox <filter>, which
          // Chromium clips to 0px height on strictly horizontal links (from.y === to.y).
          useGlow && h('path', {
            d,
            stroke: strokeColor,
            strokeWidth: baseWidth + 7,
            strokeOpacity: showDashFlow ? 0.1 : 0.16,
            strokeLinecap: 'round',
            fill: 'none',
          }),
          useGlow && h('path', {
            d,
            stroke: strokeColor,
            strokeWidth: baseWidth + 3.2,
            strokeOpacity: showDashFlow ? 0.18 : 0.3,
            strokeLinecap: 'round',
            fill: 'none',
          }),
          h('path', {
            d,
            stroke: strokeColor,
            strokeWidth: baseWidth,
            strokeOpacity: showDashFlow ? 0.35 : baseOpacity,
            strokeDasharray: isPrunedEdge ? '4 4' : undefined,
            fill: 'none',
          }),
          showDashFlow && fxLevel === 'vivid' && h('path', {
            d,
            className: 'dsh-wc-edge-flow',
            stroke: color,
            strokeWidth: 6.4,
            strokeOpacity: 0.28,
            strokeLinecap: 'round',
            fill: 'none',
          }),
          showDashFlow && h('path', {
            d,
            className: 'dsh-wc-edge-flow',
            stroke: color,
            strokeWidth: fxLevel === 'vivid' ? 2.8 : 2.4,
            strokeLinecap: 'round',
            fill: 'none',
          }),
          showBead && h('g', null,
            h('circle', { r: 6.5, fill: color, fillOpacity: 0.28 }),
            h('circle', { r: 3.3, fill: color }),
            h('animateMotion', {
              dur: '1.25s',
              repeatCount: 'indefinite',
              path: d,
            }),
          ),
        );
      });

      const renderBand = (node) => {
        const isEntry = node.id === 'lead';
        const isTB = direction === 'tb';
        const inColor = inColorByNode.get(node.id) || null;
        const inCount = inCountByNode.get(node.id) || 0;
        const inText = inCount > 1 ? 'in ×' + inCount : 'in';
        const bandH = nodeHeight(node) - SOCKET_BAND_TOP;
        const unifiedInSocket = !isEntry && h('div', {
          style: {
            ...S.socket,
            top: isTB ? (-SOCKET_BAND_TOP - PORT / 2) : ((ROW_H - PORT) / 2),
            left: isTB ? (NODE_W / 2 - PORT / 2) : (-PORT / 2),
            borderColor: inColor || C.border,
            background: inColor || C.elevated,
            boxShadow: inColor
              ? (fxLevel === 'vivid' ? '0 0 6px ' + inColor : '0 0 0 2px ' + C.elevated)
              : '0 0 0 3px transparent',
          },
          title: t('tipSocketOut'),
          onMouseDown: (e) => onInputDown(e, node.id),
          onMouseUp: (e) => onInputUp(e, node.id),
        });
        if (node.kind === 'condition') {
          const branches = conditionBranchesForUI(node, lang);
          const condDec = decisionsById[node.id] || null;
          const matchedBranchIds = condDec && Array.isArray(condDec.branches) ? new Set(condDec.branches) : null;
          const onLeft = isTB && node.tbSide === 'left';
      return h('div', { style: S.band },
            unifiedInSocket,
            !isTB && h('span', { style: { ...S.rowLabel, position: 'absolute', left: '12px', top: '3px', pointerEvents: 'none' } }, inText),
            branches.map((b) => {
              const outLinked = connectedOut.has(node.id + '|branch:' + b.id);
              const isMatchedBranch = Boolean(matchedBranchIds && matchedBranchIds.has(b.id));
              const isUnmatchedBranch = Boolean(matchedBranchIds && !matchedBranchIds.has(b.id));
              const outTip = !b.custom
                ? (b.id === 'true' ? t('tipCondTrue') : t('tipCondFalse'))
                : t('tipBranchOut');
              const editKey = 'branch:' + node.id + ':' + b.id;
      return h('div', {
                key: b.id,
                style: {
                  ...S.condBranchRow,
                  justifyContent: onLeft ? 'flex-start' : 'flex-end',
                  opacity: isUnmatchedBranch ? 0.48 : 1,
                },
              },
                h('div', {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    marginLeft: onLeft ? '10px' : 0,
                    marginRight: onLeft ? 0 : '10px',
                    gap: '2px',
                  },
                  onMouseDown: (e) => e.stopPropagation(),
                },
                  h('input', {
                    style: {
                      ...S.condBranchInput,
                      textAlign: onLeft ? 'left' : 'right',
                      borderColor: isMatchedBranch ? b.color : C.border,
                      ...(onLeft ? { borderLeft: '2px solid ' + b.color } : { borderRight: '2px solid ' + b.color }),
                    },
                    value: b.label,
                    placeholder: t('branchPh'),
                    onFocus: () => setSelectedIds([node.id]),
                    onChange: (e) => renameConditionBranch(node, b.id, e.target.value),
                  }),
                  h('button', {
                    type: 'button',
                    style: { ...S.condBranchExpand, marginRight: 0 },
                    title: t('tipExpandBranch'),
                    onMouseEnter: (e) => { e.currentTarget.style.color = C.text; e.currentTarget.style.borderColor = b.color; },
                    onMouseLeave: (e) => { e.currentTarget.style.color = C.dim; e.currentTarget.style.borderColor = C.border; },
                    onClick: () => setRoleEditFor(roleEditFor === editKey ? null : editKey),
                  }, '⤢'),
                  branches.length > 2 && h('button', {
                    type: 'button',
                    style: { ...S.condBranchDel, marginLeft: 0 },
                    title: t('delBranchTip'),
                    onMouseEnter: (e) => { e.currentTarget.style.color = '#e5534b'; },
                    onMouseLeave: (e) => { e.currentTarget.style.color = C.dim; },
                    onClick: () => removeConditionBranch(node, b.id),
                  }, '×'),
                ),
                roleEditFor === editKey && h('div', {
                  style: { ...S.rolePopover, top: '-8px' },
                  onMouseDown: (e) => e.stopPropagation(),
                },
                  h('div', {
                    style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', fontSize: '10px', color: C.dim },
                  },
                    h('span', { style: { width: '7px', height: '7px', borderRadius: '50%', background: b.color, flex: '0 0 auto' } }),
                    h('span', null, t('branchEditTitle')),
                  ),
                  h('textarea', {
                    style: S.roleArea,
                    value: b.label,
                    placeholder: t('branchPh'),
                    autoFocus: true,
                    onChange: (e) => renameConditionBranch(node, b.id, e.target.value),
                  }),
                ),
                h('div', {
                  style: {
                    ...S.socket,
                    top: (COND_ROW_H - PORT) / 2,
                    ...(onLeft ? { left: -PORT / 2 } : { right: -PORT / 2 }),
                    borderColor: b.color,
                    background: outLinked ? b.color : C.elevated,
                    boxShadow: outLinked
                      ? (fxLevel === 'vivid' ? '0 0 6px ' + b.color : '0 0 0 2px ' + C.elevated)
                      : '0 0 0 3px transparent',
                  },
                  title: outTip,
                  onMouseDown: (e) => onOutputDown(e, node.id, 'prompt', b.id),
                  onMouseUp: (e) => onOutputUp(e, node.id, 'prompt', b.id),
                }),
              );
            }),
          );
        }
        if (isTB) {
          return h('div', { style: S.band },
            unifiedInSocket,
            SOCKET_TYPES.map((sock) => {
              const outLinked = connectedOut.has(node.id + '|' + sock.id);
              const sx = outputSocketX(node, sock.id);
              return h(React.Fragment, { key: sock.id },
                h('span', {
                  style: {
                    ...S.rowLabel,
                    position: 'absolute',
                    left: sx + 'px',
                    top: (bandH - 23) + 'px',
                    transform: 'translateX(-50%)',
                    pointerEvents: 'none',
                    whiteSpace: 'nowrap',
                  },
                }, sock.label),
                h('div', {
                  style: {
                    ...S.socket,
                    top: bandH - PORT / 2,
                    left: sx - PORT / 2,
                    borderColor: sock.color,
                    background: outLinked ? sock.color : C.elevated,
                    boxShadow: outLinked
                      ? (fxLevel === 'vivid' ? '0 0 6px ' + sock.color : '0 0 0 2px ' + C.elevated)
                      : '0 0 0 3px transparent',
                  },
                  title: t('tipSocketIn'),
                  onMouseDown: (e) => onOutputDown(e, node.id, sock.id),
                  onMouseUp: (e) => onOutputUp(e, node.id, sock.id),
                }),
              );
            }),
          );
        }
        return h('div', { style: S.band },
          unifiedInSocket,
          !isEntry && h('span', { style: { ...S.rowLabel, position: 'absolute', left: '12px', top: '3px', pointerEvents: 'none' } }, inText),
          SOCKET_TYPES.map((sock) => {
            const outLinked = connectedOut.has(node.id + '|' + sock.id);
      return h('div', { key: sock.id, style: S.row },
              h('span', { style: { ...S.rowLabel, position: 'absolute', right: '12px' } }, sock.label),
              h('div', {
                style: {
                  ...S.socket,
                  right: -PORT / 2,
                  borderColor: sock.color,
                  background: outLinked ? sock.color : C.elevated,
                  boxShadow: outLinked
                    ? (fxLevel === 'vivid' ? '0 0 6px ' + sock.color : '0 0 0 2px ' + C.elevated)
                    : '0 0 0 3px transparent',
                },
                title: t('tipSocketIn'),
                onMouseDown: (e) => onOutputDown(e, node.id, sock.id),
                onMouseUp: (e) => onOutputUp(e, node.id, sock.id),
              }),
            );
          }),
        );
      };

      // The canvas grows with its nodes so links past the original size are
      // still painted instead of being clipped by the SVG viewport.
      const contentW = Math.max(CONTENT_W, WORLD_PAD + Math.max(0, ...nodes.map((n) => n.x + NODE_W)) + 400);
      const contentH = Math.max(CONTENT_H, WORLD_PAD + Math.max(0, ...nodes.map((n) => n.y + nodeHeight(n))) + 400);

      const hitTest = (m) => {
        const left = Math.min(m.x1, m.x2);
        const right = Math.max(m.x1, m.x2);
        const top = Math.min(m.y1, m.y2);
        const bottom = Math.max(m.y1, m.y2);
        return nodes
          .filter((n) => n.x + NODE_W >= left && n.x <= right && n.y + nodeHeight(n) >= top && n.y <= bottom)
          .map((n) => n.id);
      };

      /** Compact "+ 参考" trigger docked cleanly in the top-right of every node header bar. */
      const refsControlBtn = (node) => {
        const count = normalizeRefsUI(node.refs).length;
        const isOpen = refsEditFor === node.id;
        return h('button', {
          type: 'button',
          style: {
            ...(count > 0 || isOpen ? S.condModeBtnOn : S.condAddBtn),
            position: 'absolute',
            top: '9px',
            right: '10px',
            zIndex: 7,
            whiteSpace: 'nowrap',
            flex: '0 0 auto',
          },
          title: t('tipRefs'),
          onMouseDown: (e) => e.stopPropagation(),
          onClick: (e) => {
            e.stopPropagation();
            setRoleEditFor(null);
            setRefsEditFor(isOpen ? null : node.id);
          },
        }, count > 0 ? (t('refsBtn') + '×' + count) : ('+ ' + t('refsBtn')));
      };

      const refsPopoverEl = (node) => {
        if (refsEditFor !== node.id) return null;
        const list = Array.isArray(node.refs) ? node.refs : [];
        const isGlobal = node.id === 'lead';
        return h('div', {
          style: S.refsPopover,
          onMouseDown: (e) => e.stopPropagation(),
        },
          h('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px', fontSize: '10px', fontWeight: 600, color: C.dim },
          },
            h('span', null, (isGlobal ? t('refsTitleGlobal') : t('refsTitleNode')) + ' (' + list.length + '/16)'),
            h('button', {
              type: 'button',
              style: { background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontSize: '12px', padding: '0 2px' },
              onClick: () => setRefsEditFor(null),
            }, '×'),
          ),
          list.length === 0
            ? h('div', { style: { fontSize: '10px', color: C.dim, marginBottom: '6px', lineHeight: '1.4' } }, t('refsEmpty'))
            : h('div', { style: { maxHeight: '168px', overflowY: 'auto', marginBottom: '4px' } },
                list.map((val, idx) => h('div', { key: 'ref-' + idx, style: S.refsRow },
                  h('input', {
                    style: S.refsInput,
                    value: typeof val === 'string' ? val : '',
                    placeholder: t('refsPh'),
                    autoFocus: idx === list.length - 1 && val === '',
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' && list.length < 16) {
                        e.preventDefault();
                        addNodeRef(node);
                      }
                    },
                    onChange: (e) => updateNodeRef(node, idx, e.target.value),
                  }),
                  h('button', {
                    type: 'button',
                    style: S.condBranchDel,
                    title: t('delRefTip'),
                    onMouseEnter: (e) => { e.currentTarget.style.color = '#e5534b'; },
                    onMouseLeave: (e) => { e.currentTarget.style.color = C.dim; },
                    onClick: () => removeNodeRef(node, idx),
                  }, '×'),
                )),
              ),
          list.length < 16 && h('button', {
            type: 'button',
            style: { ...S.btn, width: '100%', padding: '3px 8px', fontSize: '10px', textAlign: 'center' },
            onClick: () => addNodeRef(node),
          }, t('refsAdd')),
        );
      };

      return h('div', {
        ref: rootElRef,
        style: S.root,
        onMouseEnter: () => { pointerInsideRoot.current = true; },
        onMouseLeave: () => { pointerInsideRoot.current = false; },
      },
        h('div', { style: S.toolbar },
          h('button', { style: S.btn, onClick: () => addNode('agent'), type: 'button' }, t('addAgent')),
          h('button', { style: S.btn, onClick: () => addNode('lead'), type: 'button' }, t('addLead')),
          h('button', { style: S.btn, onClick: () => addNode('condition'), type: 'button' }, t('addCond')),
          h('span', { style: S.toolSep }),
          h('button', {
            style: enabled && dirty ? S.btnDirty : S.btn,
            onClick: () => pushPlan(enabled),
            type: 'button',
            title: t('tipSync'),
          }, t('sync')),
          h('button', {
            style: S.btn,
            onClick: toggleDirection,
            type: 'button',
            title: t('tipDir'),
          }, direction === 'tb' ? t('dirTB') : t('dirLR')),
          syncNote ? h('span', { style: S.syncNote, title: syncNote }, syncNote) : null,
          h('div', { style: S.presetBar },
            (() => {
              const feedback = status || (enabled ? (dirty ? t('unsaved') : t('synced')) : '');
              return feedback ? h('span', { style: S.status, title: feedback }, feedback) : null;
            })(),
            (() => {
              const names = Object.keys(presets);
              return h('button', {
                style: S.btn,
                onClick: (e) => {
                  const next = presetOpen === 'menu' ? null : 'menu';
                  if (next) {
                    setMenuOpen(false);
                    setCtxMenu(null);
                    const rootRect = rootElRef.current && rootElRef.current.getBoundingClientRect();
                    const btnRect = e.currentTarget && e.currentTarget.getBoundingClientRect();
                    setPresetAlign(dropdownAlign(btnRect, rootRect, 248));
                  }
                  setPresetOpen(next);
                },
                type: 'button',
                title: t('tipPresets'),
              }, t('presets') + (names.length ? ' (' + names.length + ')' : ''));
            })(),
            presetOpen === 'menu' && (() => {
              const names = Object.keys(presets);
              const templates = builtinTemplates(lang, direction);
              return h('div', {
                style: {
                  ...S.presetMenu,
                  left: presetAlign === 'left' ? 0 : 'auto',
                  right: presetAlign === 'left' ? 'auto' : 0,
                },
                onMouseDown: (e) => e.stopPropagation(),
              },
                h('div', { style: S.presetSaveBox },
                  h('div', { style: S.presetSaveTitle }, t('presetSaveTitle')),
                  h('div', { style: S.presetSaveRow },
                    h('input', {
                      style: S.presetInput,
                      value: presetName,
                      placeholder: t('presetNamePh'),
                      onMouseDown: (e) => e.stopPropagation(),
                      onChange: (e) => setPresetName(e.target.value),
                      onKeyDown: (e) => { if (e.key === 'Enter') savePresetNow(); },
                    }),
                    h('button', {
                      style: { ...S.btn, padding: '4px 8px', fontSize: '11px' },
                      onClick: savePresetNow,
                      type: 'button',
                      title: t('tipSave'),
                    }, t('save')),
                  ),
                ),
                h('div', {
                  style: { ...S.presetRow, color: C.accent, fontWeight: 500, borderBottom: '1px solid ' + C.border, marginBottom: '4px', paddingBottom: '6px', borderRadius: '4px 4px 0 0' },
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => clearCanvas(),
                }, h('span', { style: S.presetRowText }, t('newBlankCanvas'))),
                h('div', { style: S.menuHead }, t('myPresets')),
                names.length
                  ? names.map((name) => h('div', {
                      key: name,
                      style: S.presetRow,
                      onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                      onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                    },
                      h('span', { style: S.presetRowText, onClick: () => applyPreset(name) }, name),
                      h('button', { style: S.presetDel, type: 'button', title: t('del'), onClick: () => deletePreset(name) }, '×'),
                    ))
                  : h('div', { style: S.presetEmpty }, t('presetEmpty')),
                h('div', { style: S.menuHead }, t('builtinTemplates')),
                templates.map((tpl) => h('div', {
                  key: tpl.id,
                  style: S.presetRow,
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => applyTemplate(tpl),
                }, h('span', { style: S.presetRowText, title: tpl.name }, tpl.name))),
              );
            })(),
            h('div', { style: S.moreBar },
              h('button', {
                style: S.btn,
                type: 'button',
                title: t('tipMore'),
                onMouseDown: (e) => e.stopPropagation(),
                onClick: (e) => {
                  const next = !menuOpen;
                  if (next) {
                    setPresetOpen(null);
                    setCtxMenu(null);
                    const rootRect = rootElRef.current && rootElRef.current.getBoundingClientRect();
                    const btnRect = e.currentTarget && e.currentTarget.getBoundingClientRect();
                    setMenuAlign(dropdownAlign(btnRect, rootRect, 204));
                  }
                  setMenuOpen(next);
                },
              }, '⋯'),
              menuOpen && h('div', {
                style: {
                  ...S.moreMenu,
                  left: menuAlign === 'left' ? 0 : 'auto',
                  right: menuAlign === 'left' ? 'auto' : 0,
                },
                onMouseDown: (e) => e.stopPropagation(),
              },
                h('div', {
                  style: S.moreRow,
                  title: t('tipUndo'),
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => { setMenuOpen(false); undo(); },
                }, t('undo')),
                h('div', {
                  style: S.moreRow,
                  title: t('tipRedo'),
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => { setMenuOpen(false); redo(); },
                }, t('redo')),
                h('div', {
                  style: S.moreRow,
                  title: t('tipLocate'),
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => { setMenuOpen(false); fitView(); },
                }, t('locate')),
                h('div', { style: S.ctxDivider }),
                h('div', {
                  style: S.moreRow,
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => { setMenuOpen(false); importFromClipboard(); },
                }, t('importBtn')),
                h('div', {
                  style: S.moreRow,
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => { setMenuOpen(false); exportToClipboard(); },
                }, t('exportBtn')),
                h('div', {
                  style: S.moreRow,
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => { setMenuOpen(false); autoLayout(); },
                }, t('autoLayoutBtn')),
                h('div', {
                  style: { ...S.moreRow, color: '#e5534b' },
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => { clearCanvas(); },
                }, t('clearCanvasBtn')),
                h('div', { style: S.ctxDivider }),
                h('div', {
                  style: S.moreRow,
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => {
                    const next = nextEffectLevel(fxLevel);
                    setFxLevel(next);
                    saveEffectLevel(next);
                    flash(t('fxLabel') + t('sep') + fxName(next));
                  },
                }, t('fxLabel') + t('sep') + fxName(fxLevel)),
                h('div', {
                  style: { ...S.moreRow, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
                  title: t('tipMaxParallel'),
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => {
                    const next = nextMaxParallel(maxParallel);
                    setMaxParallel(next);
                    maxParallelRef.current = next;
                    saveMaxParallel(next);
                    if (enabled) pushPlan(true, undefined, undefined, next);
                    else flash(t('maxParallelLabel') + t('sep') + next);
                  },
                },
                  h('span', null, t('maxParallelLabel') + t('sep') + maxParallel),
                  h('span', {
                    title: t('tipMaxParallel'),
                    style: {
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: '14px', height: '14px', borderRadius: '50%',
                      border: '1px solid ' + (maxParallel > 4 ? '#d29922' : C.dim),
                      color: maxParallel > 4 ? '#d29922' : C.dim,
                      fontSize: '10px', fontWeight: 700, lineHeight: '12px', flex: '0 0 auto',
                    },
                  }, '!'),
                ),
                h('div', {
                  style: S.moreRow,
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => {
                    const next = !cutMode;
                    setCutMode(next);
                    saveCutMode(next);
                  },
                }, t('cutLinks') + t('sep') + (cutMode ? t('on') : t('off'))),
                h('div', {
                  style: S.moreRow,
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => { toggleLang(); },
                }, t('ctxLangToggle') + t('sep') + (lang === 'zh' ? '中文' : 'EN')),
                h('div', {
                  style: S.moreRow,
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => { setMenuOpen(false); setRecordingAction(null); setShortcutsOpen(true); },
                }, t('shortcutsMenu')),
                h('div', {
                  style: S.moreRow,
                  onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                  onClick: () => { setMenuOpen(false); setHelpOpen(true); },
                }, t('help')),
              ),
            ),
          ),
        ),
        helpOpen && h('div', {
          style: S.helpOverlay,
          onMouseDown: (e) => { e.stopPropagation(); if (e.target === e.currentTarget) setHelpOpen(false); },
        },
          h('div', { style: S.helpCard },
            h('div', { style: S.helpHead },
              h('span', { style: S.helpTitle }, t('helpTitle')),
              h('button', { style: S.btn, type: 'button', onClick: () => setHelpOpen(false) }, t('close')),
            ),
            h('div', { style: S.helpBody }, t('helpBody').split('\n').map((line, i) => h('div', { key: i, style: S.helpLine }, line))),
          ),
        ),
        shortcutsOpen && (() => {
          const actionLabels = {
            addNode: t('scAddNode'),
            duplicate: t('scDuplicate'),
            delete: t('scDelete'),
            undo: t('scUndo'),
            redo: t('scRedo'),
            fitView: t('scFitView'),
            autoLayout: t('scAutoLayout'),
            toggleDir: t('scToggleDir'),
          };
          return h('div', {
            style: S.helpOverlay,
            onMouseDown: (e) => {
              e.stopPropagation();
              if (e.target === e.currentTarget) {
                setRecordingAction(null);
                setShortcutsOpen(false);
              }
            },
          },
            h('div', { style: { ...S.helpCard, maxWidth: '360px' } },
              h('div', { style: S.helpHead },
                h('span', { style: S.helpTitle }, t('shortcutsTitle')),
                h('button', {
                  style: S.btn,
                  type: 'button',
                  onClick: () => {
                    const resetMap = { ...DEFAULT_SHORTCUTS };
                    shortcutsRef.current = resetMap;
                    saveShortcuts(resetMap);
                    setShortcuts(resetMap);
                    setRecordingAction(null);
                    flash(t('shortcutsResetOk'));
                  },
                }, t('shortcutsReset')),
                h('button', {
                  style: S.btn,
                  type: 'button',
                  onClick: () => { setRecordingAction(null); setShortcutsOpen(false); },
                }, t('close')),
              ),
              h('div', { style: { fontSize: '10px', color: C.dim, marginBottom: '8px', lineHeight: '1.45' } }, t('shortcutsHint')),
              SHORTCUT_ORDER.map((actionId, idx) => {
                const binding = shortcuts[actionId] || '';
                const isRec = recordingAction === actionId;
                return h('div', {
                  key: actionId,
                  style: idx === SHORTCUT_ORDER.length - 1 ? { ...S.shortcutRow, borderBottom: 'none' } : S.shortcutRow,
                },
                  h('span', null, actionLabels[actionId] || actionId),
                  h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
                    h('button', {
                      type: 'button',
                      style: isRec ? { ...S.shortcutKeyBtn, ...S.shortcutKeyRec } : (binding ? S.shortcutKeyBtn : { ...S.shortcutKeyBtn, color: C.dim }),
                      onClick: () => setRecordingAction(isRec ? null : actionId),
                    }, isRec ? t('shortcutsPress') : (binding || t('shortcutsUnset'))),
                    binding
                      ? h('button', {
                          type: 'button',
                          style: S.condBranchDel,
                          title: t('del'),
                          onMouseEnter: (e) => { e.currentTarget.style.color = '#e5534b'; },
                          onMouseLeave: (e) => { e.currentTarget.style.color = C.dim; },
                          onClick: () => {
                            const { next } = applyShortcutBinding(shortcutsRef.current, actionId, '');
                            shortcutsRef.current = next;
                            saveShortcuts(next);
                            setShortcuts(next);
                            if (recordingAction === actionId) setRecordingAction(null);
                          },
                        }, '×')
                      : h('span', { style: S.condBranchDelSpacer }),
                  ),
                );
              }),
            ),
          );
        })(),
        h('div', {
          ref: canvasWrapRef,
          style: S.canvasWrap,
          onMouseMove: (e) => { lastMouseRef.current = { clientX: e.clientX, clientY: e.clientY }; },
          onContextMenu: (e) => {
            const tag = e.target && e.target.tagName;
            if (tag !== 'INPUT' && tag !== 'TEXTAREA') e.preventDefault();
          },
        },
          h('button', {
            style: enabled
              ? {
                  ...S.floatOn,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  lineHeight: '14px',
                  boxShadow: fxLevel === 'vivid'
                    ? '0 0 14px rgba(47,129,247,0.35), 0 4px 14px rgba(0,0,0,0.35)'
                    : S.floatOn.boxShadow,
                }
              : { ...S.floatOff, display: 'inline-flex', alignItems: 'center', gap: '6px', lineHeight: '14px' },
            type: 'button',
            onMouseDown: (e) => e.stopPropagation(),
            onClick: toggleEnabled,
            title: t('tipToggle'),
          },
            h('span', {
              className: enabled && fxLevel === 'vivid' ? 'dsh-wc-dot-live' : undefined,
              style: enabled
                ? { width: '7px', height: '7px', borderRadius: '50%', background: C.accent, flex: '0 0 auto' }
                : { width: '7px', height: '7px', borderRadius: '50%', border: '1.5px solid ' + C.dim, boxSizing: 'border-box', flex: '0 0 auto' },
            }),
            h('span', null, (enabled ? t('enabled') : t('disabled')).replace(/^[●○]\s*/, '')),
          ),
          addMenu && (() => {
            const lf = addMenu.linkFrom || null;
            const srcNode = lf && lf.fromId ? nodeById.get(lf.fromId) : null;
            const compat = lf ? compatibleTargetsForWire(srcNode, lf.type) : { agent: true, lead: true, condition: true, leadBlockedReason: '' };
      return h('div', {
              style: { ...S.addMenu, left: addMenu.sx + 'px', top: addMenu.sy + 'px' },
              onMouseDown: (e) => e.stopPropagation(),
            },
              h('div', { style: S.addMenuHead }, lf ? t('addMenuLinkTitle') : t('addMenuTitle')),
              h('div', {
                style: S.addMenuRow,
                onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                onClick: () => addNode('agent', { x: addMenu.wx, y: addMenu.wy }, lf),
              }, h('span', null, t('addAgent')), h('span', { style: S.addMenuHint }, '1')),
              h('div', {
                style: compat.lead ? S.addMenuRow : S.addMenuRowDisabled,
                title: compat.lead ? undefined : t(compat.leadBlockedReason || 'leadToLeadBlocked'),
                onMouseEnter: (e) => { if (compat.lead) e.currentTarget.style.background = C.hover; },
                onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                onClick: () => { if (compat.lead) addNode('lead', { x: addMenu.wx, y: addMenu.wy }, lf); },
              }, h('span', null, t('addLead')), h('span', { style: S.addMenuHint }, '2')),
              h('div', {
                style: S.addMenuRow,
                onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                onClick: () => addNode('condition', { x: addMenu.wx, y: addMenu.wy }, lf),
              }, h('span', null, t('addCond')), h('span', { style: S.addMenuHint }, '3')),
            );
          })(),
          ctxMenu && (() => {
            const menuRow = (key, label, onClick, opts) => {
              const danger = opts && opts.danger;
              const hint = opts && opts.hint;
              return h('div', {
                key,
                style: danger ? { ...S.addMenuRow, color: '#e5534b' } : S.addMenuRow,
                onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                onClick,
              }, h('span', null, label), hint ? h('span', { style: S.addMenuHint }, hint) : null);
            };
            if (ctxMenu.kind === 'node') {
              const target = nodeById.get(ctxMenu.nodeId);
              if (!target) return null;
              const multiSel = selectedIds.length > 1 && selectedSet.has(target.id);
              const nonLeadCount = (multiSel ? selectedIds : [target.id]).filter((id) => id !== 'lead').length;
              const suffix = nonLeadCount > 1 ? ' ×' + nonLeadCount : '';
              const latestRun = target.kind !== 'lead' ? runsById[target.id] : null;
              return h('div', {
                style: { ...S.addMenu, minWidth: '172px', left: ctxMenu.sx + 'px', top: ctxMenu.sy + 'px' },
                onMouseDown: (e) => e.stopPropagation(),
                onContextMenu: (e) => e.preventDefault(),
              },
                h('div', { style: S.addMenuHead }, t('ctxNodeTitle')),
                menuRow('edit', t('ctxEditText'), () => { setCtxMenu(null); setRoleEditFor(target.id); }),
                menuRow('refs', t('ctxManageRefs'), () => { setCtxMenu(null); setRefsEditFor(target.id); }),
                latestRun && menuRow('chat', t('ctxOpenChat'), () => { setCtxMenu(null); openNodeSession(target); }),
                nonLeadCount > 0 && h('div', { style: S.ctxDivider }),
                nonLeadCount > 0 && menuRow('dup', t('ctxDup') + suffix, () => { setCtxMenu(null); duplicateSelected(); }, { hint: shortcuts.duplicate || '' }),
                nonLeadCount > 0 && menuRow('del', t('ctxDelNode') + suffix, () => {
                  setCtxMenu(null);
                  if (multiSel) deleteSelected();
                  else deleteNode(target.id);
                }, { danger: true, hint: shortcuts.delete === 'Delete' ? 'Del' : (shortcuts.delete || '') }),
              );
            }
            if (ctxMenu.kind === 'edge') {
              const targetEdge = edges.find((ed) => ed.id === ctxMenu.edgeId);
              if (!targetEdge) return null;
              return h('div', {
                style: { ...S.addMenu, minWidth: '172px', left: ctxMenu.sx + 'px', top: ctxMenu.sy + 'px' },
                onMouseDown: (e) => e.stopPropagation(),
                onContextMenu: (e) => e.preventDefault(),
              },
                h('div', { style: S.addMenuHead }, t('ctxEdgeTitle')),
                menuRow('ins-agent', t('ctxInsertAgent'), () => insertNodeOnEdge(targetEdge.id, 'agent', { x: ctxMenu.wx, y: ctxMenu.wy })),
                menuRow('ins-cond', t('ctxInsertCond'), () => insertNodeOnEdge(targetEdge.id, 'condition', { x: ctxMenu.wx, y: ctxMenu.wy })),
                h('div', { style: S.ctxDivider }),
                menuRow('del-edge', t('ctxDelEdge'), () => deleteEdgeById(targetEdge.id), { danger: true }),
              );
            }
            return h('div', {
              style: { ...S.addMenu, minWidth: '176px', left: ctxMenu.sx + 'px', top: ctxMenu.sy + 'px' },
              onMouseDown: (e) => e.stopPropagation(),
              onContextMenu: (e) => e.preventDefault(),
            },
              h('div', { style: S.addMenuHead }, t('ctxCanvasTitle')),
              menuRow('add-agent', t('addAgent'), () => addNode('agent', { x: ctxMenu.wx, y: ctxMenu.wy })),
              menuRow('add-lead', t('addLead'), () => addNode('lead', { x: ctxMenu.wx, y: ctxMenu.wy })),
              menuRow('add-cond', t('addCond'), () => addNode('condition', { x: ctxMenu.wx, y: ctxMenu.wy })),
              h('div', { style: S.ctxDivider }),
              menuRow('undo', t('undo'), () => { setCtxMenu(null); undo(); }, { hint: shortcuts.undo || '' }),
              menuRow('redo', t('redo'), () => { setCtxMenu(null); redo(); }, { hint: shortcuts.redo || '' }),
              menuRow('layout', t('autoLayoutBtn'), () => { setCtxMenu(null); autoLayout(); }, { hint: shortcuts.autoLayout || '' }),
              menuRow('dir', direction === 'tb' ? t('dirLR') : t('dirTB'), () => { setCtxMenu(null); toggleDirection(); }, { hint: shortcuts.toggleDir || '' }),
              menuRow('fit', t('locate'), () => { setCtxMenu(null); fitView(); }, { hint: shortcuts.fitView || '' }),
              h('div', { style: S.ctxDivider }),
              menuRow('imp', t('importBtn'), () => { setCtxMenu(null); importFromClipboard(); }),
              menuRow('clr', t('clearCanvasBtn'), () => { setCtxMenu(null); clearCanvas(); }, { danger: true }),
            );
          })(),
          h('div', {
            style: S.floatZoomBar,
            onMouseDown: (e) => e.stopPropagation(),
          },
            h('button', {
              style: S.floatZoomBtn,
              type: 'button',
              title: t('tipLocate'),
              onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
              onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
              onClick: () => fitView(),
            }, '⊡'),
            h('span', { style: { width: '1px', height: '12px', background: C.border, opacity: 0.7 } }),
            h('button', {
              style: { ...S.floatZoomBtn, cursor: 'ew-resize', minWidth: '42px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
              type: 'button',
              title: t('tipResetZoom'),
              onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
              onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
              onMouseDown: onZoomPillDown,
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusLead(1); } },
            }, Math.round(view.k * 100) + '%'),
          ),
          h('div', {
            ref: canvasElRef,
            style: {
              ...S.canvas,
              cursor: panning ? 'grabbing' : (spaceHeld ? 'grab' : undefined),
            },
            onMouseDown: onCanvasDown,
          },
          h('div', {
            ref: contentRef,
            style: {
              ...S.content, width: contentW, height: contentH, overflow: 'visible',
              transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')',
              transformOrigin: '0 0',
            },
          },
            h('svg', { width: contentW, height: contentH, style: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' } },
              h('g', null, edgeEls),
              cutPath.length > 1 && h('polyline', {
                points: cutPath.map((pt) => (pt.x + WORLD_PAD) + ',' + (pt.y + WORLD_PAD)).join(' '),
                fill: 'none',
                stroke: '#e5534b',
                strokeWidth: 1.5,
                strokeDasharray: '5 4',
              }),
              marquee && h('rect', {
                x: Math.min(marquee.x1, marquee.x2) + WORLD_PAD,
                y: Math.min(marquee.y1, marquee.y2) + WORLD_PAD,
                width: Math.abs(marquee.x2 - marquee.x1),
                height: Math.abs(marquee.y2 - marquee.y1),
                fill: 'rgba(47,129,247,0.12)',
                stroke: C.accent,
                strokeWidth: 1,
                strokeDasharray: '4 3',
              }),
              (pending || (addMenu && addMenu.linkFrom)) && (() => {
                const wire = pending || addMenu.linkFrom;
                const color = wire.color || (SOCKET_TYPES.find((t) => t.id === wire.type) || SOCKET_TYPES[0]).color;
                const d = 'M ' + (wire.sx + WORLD_PAD) + ' ' + (wire.sy + WORLD_PAD) + ' L ' + (wire.x + WORLD_PAD) + ' ' + (wire.y + WORLD_PAD);
                return h('path', { d, stroke: color, strokeWidth: 2, strokeDasharray: '4 4', fill: 'none' });
              })(),
            ),
            nodes.map((node) => {
              const isEntry = node.id === 'lead';
              const isLeadKind = node.kind === 'lead';
              const isCondKind = node.kind === 'condition';
              const roleInput = (style) => h('div', { style },
                h('span', { style: S.fieldLabel }, t('role')),
                h('input', {
                  style: S.input,
                  value: node.role || '',
                  placeholder: isLeadKind ? t('rolePhLead') : t('rolePhAgent'),
                  onMouseDown: (e) => e.stopPropagation(),
                  onFocus: () => setSelectedIds([node.id]),
                  onChange: (e) => updateNode(node.id, { role: e.target.value }),
                }),
              );
              const isOrphan = node.id !== 'lead' && !reachableIds.has(node.id);
              const isSoloLead = soloLeadIds.has(node.id);
              const isDeadEnd = deadEndIds.has(node.id);
              const isInactive = isOrphan || isSoloLead || isDeadEnd;
              const isSelected = selectedSet.has(node.id);
              const nodeStatus = enabled ? statusById[node.id] : undefined;
              const isLeadReady = leadReadyIds.has(node.id);
              const isLeadDone = leadDoneIds.has(node.id);
              const isRunning = !isLeadKind && nodeStatus === 'running';
              const isDone = (!isLeadKind && nodeStatus === 'done') || isLeadDone;
              const isFailed = !isLeadKind && nodeStatus === 'failed';
              const isPulsing = (isRunning || isLeadReady) && fxLevel !== 'minimal';
              const nodeClass = 'dsh-wc-node'
                + (isPulsing ? (fxLevel === 'vivid' ? ' dsh-wc-running-vivid' : ' dsh-wc-running-std') : '');
              const stateStyle = isSelected
                ? S.nodeSel
                : isRunning || isLeadReady
                  ? { border: '1.5px solid #2f81f7' }
                  : isFailed
                    ? { border: '1.5px solid rgba(229,83,75,0.8)', boxShadow: '0 0 12px rgba(229,83,75,0.18)' }
                    : isDone
                      ? { border: '1px solid rgba(63,185,80,0.55)' }
                      : isDeadEnd
                        ? { border: '1px solid rgba(210,153,34,0.55)' }
                        : null;
              const topBarBg = (isRunning || isLeadReady) && fxLevel === 'vivid'
                ? (isLeadKind
                  ? 'linear-gradient(90deg, #2f81f7 0%, #79c0ff 50%, #2f81f7 100%)'
                  : (isCondKind
                    ? 'linear-gradient(90deg, #d29922 0%, #f2cc60 50%, #d29922 100%)'
                    : 'linear-gradient(90deg, #2f81f7 0%, #58d580 50%, #2f81f7 100%)'))
                : (isFailed ? '#e5534b' : (isLeadKind ? '#2f81f7' : (isCondKind ? '#d29922' : '#3fb950')));
              const isPruned = enabled && prunedSet.has(node.id);
              const condDecision = isCondKind ? (decisionsById[node.id] || null) : null;
              const verdictInfo = condDecision ? conditionVerdictSummary(condDecision, lang) : null;
              const hasOpenPopover = decisionViewFor === node.id
                || refsEditFor === node.id
                || roleEditFor === node.id
                || (typeof roleEditFor === 'string' && roleEditFor.includes(':' + node.id + ':'));
              return h('div', {
                key: node.id,
                'data-node': node.id,
                className: nodeClass,
                style: {
                  ...S.node,
                  height: nodeHeight(node),
                  left: node.x + WORLD_PAD,
                  top: node.y + WORLD_PAD,
                  ...(isLeadKind ? S.leadNode : null),
                  ...(isInactive || isPruned ? S.orphanNode : null),
                  ...(stateStyle || null),
                  ...(hasOpenPopover ? { zIndex: 40 } : null),
                },
                title: isPruned ? t('tipPruned') : (isOrphan ? t('orphanTip') : (isSoloLead ? t('tipSoloLead') : (isDeadEnd ? t('tipDeadEnd') : undefined))),
                onMouseDown: (e) => onNodeDown(e, node.id),
                onContextMenu: (e) => onNodeContextMenu(e, node),
              },
                h('div', {
                  className: (isRunning || isLeadReady) && fxLevel === 'vivid' ? 'dsh-wc-topbar-vivid' : undefined,
                  style: {
                    ...S.topBar,
                    background: topBarBg,
                  },
                }),
                h('div', { style: S.nodeHeader }),
                h('div', { style: S.bandDivider }),
                isEntry
                  ? (() => {
                      const waitingLead = runState
                        ? (runState.waitingLead || null)
                        : (leadReadyIds.size > 0 ? { id: Array.from(leadReadyIds)[0] } : null);
                      const btn = entryRunButtonState({
                        enabled,
                        task: node.task || '',
                        sessionRunning,
                        waitingLead,
                        triggering: runTriggering,
                        lang,
                      });
                      const isReady = btn.state === 'ready';
                      const isRun = btn.state === 'running';
                      const isWait = btn.state === 'waiting';
                      const color = isReady ? '#3fb950' : (isRun ? '#2f81f7' : (isWait ? '#d29922' : C.dim));
                      const bg = isReady
                        ? 'rgba(63,185,80,0.14)'
                        : (isRun ? 'rgba(47,129,247,0.14)' : (isWait ? 'rgba(210,153,34,0.14)' : C.elevated));
                      const borderColor = isReady
                        ? 'rgba(63,185,80,0.6)'
                        : (isRun ? 'rgba(47,129,247,0.6)' : (isWait ? 'rgba(210,153,34,0.6)' : C.border));
                      return h('button', {
                        type: 'button',
                        disabled: btn.disabled,
                        style: {
                          ...S.statusBtn,
                          bottom: direction === 'tb' ? '28px' : '4px',
                          color,
                          background: bg,
                          borderColor,
                          opacity: btn.state === 'disabled' ? 0.55 : 1,
                          cursor: btn.disabled ? 'not-allowed' : 'pointer',
                          fontWeight: isReady ? 600 : 500,
                        },
                        title: btn.title,
                        onMouseDown: (e) => e.stopPropagation(),
                        onMouseEnter: (e) => { if (!btn.disabled) e.currentTarget.style.background = 'rgba(63,185,80,0.24)'; },
                        onMouseLeave: (e) => { e.currentTarget.style.background = bg; },
                        onClick: (e) => { e.stopPropagation(); if (!btn.disabled) runFromEntry(); },
                      },
                        isRun && h('span', {
                          className: fxLevel !== 'minimal' ? 'dsh-wc-dot-live' : undefined,
                          style: { width: '6px', height: '6px', borderRadius: '50%', background: color, flex: '0 0 auto' },
                        }),
                        btn.label,
                      );
                    })()
                  : isDeadEnd
                  ? h('div', {
                      style: S.warnChip,
                      title: t('tipDeadEnd'),
                      onMouseDown: (e) => e.stopPropagation(),
                    }, '⚠ ', t('stDeadEnd'))
                  : (() => {
                      const latestRun = !isLeadKind ? runsById[node.id] : null;
                      const statusColor = isLeadReady ? '#2f81f7'
                        : isLeadDone ? '#3fb950'
                          : isLeadKind ? C.dim
                            : nodeStatus === 'running' ? '#2f81f7'
                              : nodeStatus === 'failed' ? '#e5534b'
                                : nodeStatus === 'done' ? '#3fb950' : C.dim;
                      const statusTint = isLeadReady || nodeStatus === 'running'
                        ? 'rgba(47,129,247,0.14)'
                        : nodeStatus === 'failed'
                          ? 'rgba(229,83,75,0.14)'
                          : isDone
                            ? 'rgba(63,185,80,0.14)'
                            : 'transparent';
                      const statusLabel = isPruned ? t('stPruned')
                        : isOrphan ? t('stOrphan')
                          : isSoloLead ? t('stSoloLead')
                            : isLeadReady ? t('stLeadReady')
                              : isLeadDone ? t('stDone')
                                : isLeadKind ? t('stLead')
                                  : nodeStatus === 'running' ? t('stRunning')
                                    : nodeStatus === 'failed' ? t('stFailed')
                                      : nodeStatus === 'done' ? t('stDone') : t('stPending');
                      const glyph = nodeStatus === 'running'
                        ? h('span', {
                            className: fxLevel !== 'minimal' ? 'dsh-wc-dot-live' : undefined,
                            style: { width: '6px', height: '6px', borderRadius: '50%', background: statusColor, flex: '0 0 auto' },
                          })
                        : isLeadReady ? h('span', { className: fxLevel !== 'minimal' ? 'dsh-wc-dot-live' : undefined }, '⏸')
                          : isDone ? '✓'
                            : nodeStatus === 'failed' ? '✕' : null;
                      if (latestRun) {
                        const label = enabled ? statusLabel : t('openChat');
                        const color = enabled ? statusColor : C.accent;
                        const bg = enabled && statusTint !== 'transparent' ? statusTint : C.elevated;
                        return h('button', {
                          type: 'button',
                          style: { ...S.statusBtn, bottom: (direction === 'tb' && !isCondKind) ? '28px' : '4px', color, background: bg, borderColor: color === C.dim ? C.border : color },
                          title: t('tipOpenRun'),
                          onMouseDown: (e) => e.stopPropagation(),
                          onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                          onMouseLeave: (e) => { e.currentTarget.style.background = bg; },
                          onClick: (e) => { e.stopPropagation(); openNodeSession(node); },
                        }, enabled ? glyph : null, label, ' ↗');
                      }
                      if (!enabled) return null;
      return h('div', {
                        style: {
                          ...S.statusChip,
                          bottom: (direction === 'tb' && !isCondKind) ? '28px' : '5px',
                          color: statusColor,
                          background: statusTint,
                          border: statusTint !== 'transparent' ? ('1px solid ' + statusColor) : 'none',
                        },
                        title: isLeadReady ? t('tipLeadReady') : (isLeadKind ? t('tipLead') : (isOrphan ? t('tipOrphan') : t('tipStatus'))),
                      }, glyph, statusLabel);
                    })(),
                isEntry
                  ? h('div', { style: S.titleReadonly }, t('leadThis'))
                  : h('input', {
                      style: S.title,
                      value: node.label,
                      onMouseDown: (e) => e.stopPropagation(),
                      onFocus: () => setSelectedIds([node.id]),
                      onChange: (e) => updateNode(node.id, { label: e.target.value }),
                    }),
                isEntry
                  ? h(React.Fragment, null,
                    h('div', { style: S.leadLabel },
                      h('span', { style: S.fieldLabel }, t('task')),
                      h('button', {
                        type: 'button',
                        style: S.condAddBtn,
                        title: t('tipExpandEdit'),
                        onMouseDown: (e) => e.stopPropagation(),
                        onClick: () => setRoleEditFor(roleEditFor === node.id ? null : node.id),
                      }, '⤢'),
                    ),
                    h('textarea', {
                      style: S.task,
                      value: node.task || '',
                      placeholder: t('taskPh'),
                      onMouseDown: (e) => e.stopPropagation(),
                      onFocus: () => setSelectedIds([node.id]),
                      onChange: (e) => updateNode(node.id, { task: e.target.value }),
                    }),
                    roleEditFor === node.id && h('div', {
                      style: S.rolePopover,
                      onMouseDown: (e) => e.stopPropagation(),
                    },
                      h('textarea', {
                        style: S.roleArea,
                        value: node.task || '',
                        placeholder: t('taskPh'),
                        autoFocus: true,
                        onChange: (e) => updateNode(node.id, { task: e.target.value }),
                      }),
                    ),
                  )
                  : isLeadKind
                    ? h(React.Fragment, null,
                      h('div', { style: S.leadLabel },
                        h('span', { style: S.fieldLabel }, t('role')),
                        h('button', {
                          type: 'button',
                          style: S.condAddBtn,
                          title: t('tipExpandEdit'),
                          onMouseDown: (e) => e.stopPropagation(),
                          onClick: () => setRoleEditFor(roleEditFor === node.id ? null : node.id),
                        }, '⤢'),
                      ),
                      h('textarea', {
                        style: S.task,
                        value: node.role || '',
                        placeholder: t('rolePhLead'),
                        onMouseDown: (e) => e.stopPropagation(),
                        onFocus: () => setSelectedIds([node.id]),
                        onChange: (e) => updateNode(node.id, { role: e.target.value }),
                      }),
                      roleEditFor === node.id && h('div', {
                        style: S.rolePopover,
                        onMouseDown: (e) => e.stopPropagation(),
                      },
                        h('textarea', {
                          style: S.roleArea,
                          value: node.role || '',
                          placeholder: t('rolePhLead'),
                          autoFocus: true,
                          onChange: (e) => updateNode(node.id, { role: e.target.value }),
                        }),
                      ),
                    )
                    : isCondKind
                      ? h(React.Fragment, null,
                        h('div', { style: S.fieldModel },
                          h('span', { style: lang === 'en' ? S.fieldLabelEn : S.fieldLabel }, t('model')),
                          modelControl(node),
                        ),
                        h('div', { style: S.fieldReason },
                          h('span', { style: lang === 'en' ? S.fieldLabelEn : S.fieldLabel }, t('reason')),
                          reasoningControl(node),
                        ),
                        h('div', { style: S.fieldScope },
                          h('span', { style: lang === 'en' ? S.fieldLabelEn : S.fieldLabel }, t('fallbackModel')),
                          fallbackControl(node),
                        ),
                        h('div', { style: S.condLabelRow },
                          h('span', { style: S.fieldLabel }, t('condLabel')),
                          h('div', { style: S.condBtnGroup },
                            direction === 'tb' && h('button', {
                              type: 'button',
                              style: S.condAddBtn,
                              title: t('tipCondSide'),
                              onMouseDown: (e) => e.stopPropagation(),
                              onClick: () => updateNode(node.id, { tbSide: node.tbSide === 'left' ? 'right' : 'left' }),
                            }, node.tbSide === 'left' ? t('condSideL') : t('condSideR')),
                            h('button', {
                              type: 'button',
                              style: node.multiMatch ? S.condModeBtnOn : S.condAddBtn,
                              title: t('tipMatchMode'),
                              onMouseDown: (e) => e.stopPropagation(),
                              onClick: () => updateNode(node.id, { multiMatch: !node.multiMatch }),
                            }, node.multiMatch ? t('matchMulti') : t('matchSingle')),
                            h('button', {
                              type: 'button',
                              style: S.condAddBtn,
                              title: t('tipExpandEdit'),
                              onMouseDown: (e) => e.stopPropagation(),
                              onClick: () => setRoleEditFor(roleEditFor === node.id ? null : node.id),
                            }, '⤢'),
                            conditionBranchesForUI(node, lang).length < 16 && h('button', {
                              type: 'button',
                              style: S.condAddBtn,
                              onMouseDown: (e) => e.stopPropagation(),
                              onMouseEnter: (e) => { e.currentTarget.style.color = C.text; e.currentTarget.style.borderColor = C.accent; },
                              onMouseLeave: (e) => { e.currentTarget.style.color = C.dim; e.currentTarget.style.borderColor = C.border; },
                              onClick: () => addConditionBranch(node),
                            }, t('addBranch')),
                          ),
                        ),
                        h('textarea', {
                          style: S.condArea,
                          value: node.role || '',
                          placeholder: t('condPh'),
                          onMouseDown: (e) => e.stopPropagation(),
                          onFocus: () => setSelectedIds([node.id]),
                          onChange: (e) => updateNode(node.id, { role: e.target.value }),
                        }),
                        roleEditFor === node.id && h('div', {
                          style: S.rolePopover,
                          onMouseDown: (e) => e.stopPropagation(),
                        },
                          h('textarea', {
                            style: S.roleArea,
                            value: node.role || '',
                            placeholder: t('condPh'),
                            autoFocus: true,
                            onChange: (e) => updateNode(node.id, { role: e.target.value }),
                          }),
                        ),
                      )
                      : h(React.Fragment, null,
                      h('div', { style: S.fieldModel },
                        h('span', { style: lang === 'en' ? S.fieldLabelEn : S.fieldLabel }, t('model')),
                        modelControl(node),
                      ),
                      h('div', { style: S.fieldReason },
                        h('span', { style: lang === 'en' ? S.fieldLabelEn : S.fieldLabel }, t('reason')),
                        reasoningControl(node),
                      ),
                      h('div', { style: S.fieldScope },
                        h('span', { style: lang === 'en' ? S.fieldLabelEn : S.fieldLabel }, t('scope')),
                        scopeToggle(node),
                      ),
                      h('div', { style: S.fieldFallback },
                        h('span', { style: lang === 'en' ? S.fieldLabelEn : S.fieldLabel }, t('fallbackModel')),
                        fallbackControl(node),
                      ),
                      h('div', { style: S.fieldMemory },
                        h('span', { style: lang === 'en' ? S.fieldLabelEn : S.fieldLabel }, t('memory')),
                        memoryToggle(node),
                      ),
                      h('div', { style: S.fieldRole },
                        h('span', { style: lang === 'en' ? S.fieldLabelEn : S.fieldLabel }, t('role')),
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', flex: '1 1 auto', minWidth: 0 } },
                          h('input', {
                            style: {
                              flex: '1 1 auto', minWidth: 0, height: '18px', boxSizing: 'border-box',
                              padding: '0 5px', borderRadius: '4px',
                              border: '1px solid ' + C.border, background: C.base, color: C.text,
                              fontSize: '10px', lineHeight: '14px', outline: 'none', userSelect: 'text',
                            },
                            value: node.role || '',
                            placeholder: t('rolePhAgent'),
                            onMouseDown: (e) => e.stopPropagation(),
                            onFocus: () => setSelectedIds([node.id]),
                            onChange: (e) => updateNode(node.id, { role: e.target.value }),
                          }),
                          h('button', {
                            style: { ...S.condAddBtn, height: '18px', padding: '0 5px', flex: '0 0 auto' },
                            type: 'button',
                            title: t('tipExpandEdit'),
                            onMouseDown: (e) => e.stopPropagation(),
                            onMouseEnter: (e) => { e.currentTarget.style.color = C.text; e.currentTarget.style.borderColor = C.accent; },
                            onMouseLeave: (e) => { e.currentTarget.style.color = C.dim; e.currentTarget.style.borderColor = C.border; },
                            onClick: () => setRoleEditFor(roleEditFor === node.id ? null : node.id),
                          }, '⤢'),
                        ),
                      ),
                      roleEditFor === node.id && h('div', {
                        style: S.rolePopover,
                        onMouseDown: (e) => e.stopPropagation(),
                      },
                        h('textarea', {
                          style: S.roleArea,
                          value: node.role || '',
                          placeholder: t('rolePhAgent'),
                          autoFocus: true,
                          onChange: (e) => updateNode(node.id, { role: e.target.value }),
                        }),
                      ),
                    ),
                selectedIds.includes(node.id) && node.id !== 'lead' && h('div', {
                  style: S.nodeDelete,
                  title: t('delNodeTip'),
                  onMouseDown: (e) => e.stopPropagation(),
                  onClick: () => deleteNode(node.id),
                }, '×'),
                verdictInfo && h('button', {
                  type: 'button',
                  style: {
                    ...S.verdictChip,
                    color: verdictInfo.tone === 'failed' ? '#e5534b' : (verdictInfo.tone === 'warn' ? '#d29922' : '#3fb950'),
                    borderColor: verdictInfo.tone === 'failed' ? 'rgba(229,83,75,0.65)' : (verdictInfo.tone === 'warn' ? 'rgba(210,153,34,0.65)' : 'rgba(63,185,80,0.55)'),
                  },
                  title: (condDecision && condDecision.reason ? condDecision.reason + '\n' : '') + t('tipVerdictChip'),
                  onMouseDown: (e) => e.stopPropagation(),
                  onClick: (e) => {
                    e.stopPropagation();
                    setDecisionViewFor(decisionViewFor === node.id ? null : node.id);
                  },
                }, verdictInfo.text),
                decisionViewFor === node.id && condDecision && h('div', {
                  style: S.verdictPopover,
                  onMouseDown: (e) => e.stopPropagation(),
                },
                  h('div', {
                    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '5px', fontWeight: 600, fontSize: '11px' },
                  },
                    h('span', null, t('verdictReasonTitle')),
                    h('button', {
                      type: 'button',
                      style: { background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer', fontSize: '12px', padding: '0 2px' },
                      onClick: () => setDecisionViewFor(null),
                    }, '×'),
                  ),
                  Array.isArray(condDecision.branchLabels) && condDecision.branchLabels.length > 0 && h('div', {
                    style: { fontSize: '10px', color: '#3fb950', marginBottom: '4px' },
                  }, t('verdictMatched') + condDecision.branchLabels.join(' · ')),
                  condDecision.fallbackLead && h('div', {
                    style: { fontSize: '10px', color: '#d29922', marginBottom: '4px' },
                  }, t('verdictFallback') + condDecision.fallbackLead),
                  h('div', {
                    style: { maxHeight: '140px', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: C.text, fontSize: '11px' },
                  }, (condDecision.reason && String(condDecision.reason).trim()) || t('verdictNoReason')),
                ),
                refsControlBtn(node),
                refsPopoverEl(node),
                renderBand(node),
              );
            }),
          ),
        ),
        ),
      );
    }

    return {
      inject: ['slots', 'sessions', 'remote', 'remote.session', 'sidebarRight'],
      apply(ctx) {
        try {
        hostCtx = ctx;
        ctx.inject(['sidebarRightTabs'], (scope) => {
          scope.effect(() => scope.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            // Keep the tab (and its canvas state) alive while the pane is closed.
            keepMounted: true,
            title: () => 'Workflow',
            guide: [{
              id: 'workflow-canvas',
              order: 100,
              title: () => 'Workflow canvas',
              description: () => pick('画一张子代理流程图', 'Sketch a subagent workflow'),
            }],
          }), 'workflow-canvas: tab type');

          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
          }, (props) => h(CanvasBoundary, null, h(WorkflowCanvas, props)))), 'workflow-canvas: tab body');
        });
        } catch (error) {
          try { console.error('[workflow-canvas] apply failed', error); } catch (_e) { /* ignore */ }
        }
      },
      __test: { topoOrder, wouldCycle, soloLeadNodeIds, layoutGraph, builtinTemplates, deadEndNodeIds, nextEffectLevel, nextMaxParallel, dropdownAlign, zoomAroundPoint, scrubZoom, buildPlan, loadDoc, saveDoc, storageKey, socketCenterY, nodeHeight, conditionBranchesForUI, distanceToEdge, edgeCurve, compatibleTargetsForWire, conditionVerdictSummary, entryRunButtonState, outputSocketX, inputSocketPos, outputSocketPos, normalizeRefsUI, clampMenuPos, cloneSelection, nextSelectionOnNodeClick, DEFAULT_SHORTCUTS, normalizeShortcut, formatShortcutFromEvent, matchesShortcut, applyShortcutBinding },
    };
  },
});
