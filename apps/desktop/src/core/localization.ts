export type UiLanguage = "pt-BR" | "en-US" | "ru-RU" | "ja-JP";

type Dictionary = Record<string, string>;

const dictionaries: Record<Exclude<UiLanguage, "pt-BR">, Dictionary> = {
  "en-US": {
    "Conexão": "Connection", "Dispositivos": "Devices", "Favoritos": "Favorites", "Configurações": "Settings",
    "Bem-vindo de volta": "Welcome back", "Acesso remoto simples, rápido e seguro.": "Simple, fast, and secure remote access.",
    "Seu Nodus ID": "Your Nodus ID", "Disponível para conexões": "Available for connections", "Copiar Nodus ID": "Copy Nodus ID",
    "Conectar a outro dispositivo": "Connect to another device", "Digite o Nodus ID": "Enter the Nodus ID", "Conectar": "Connect",
    "Usar senha de acesso": "Use access password", "Senha definida no outro Nodus": "Password set on the other Nodus",
    "Salvar senha neste dispositivo": "Save password on this device", "Recentes:": "Recent:", "Status do Sistema": "System Status",
    "Serviço Nodus": "Nodus Service", "Conexão protegida": "Protected connection", "Estável": "Stable", "Online": "Online", "Offline": "Offline",
    "Acesso rápido": "Quick access", "Configurar senha": "Set password", "Ajuda e suporte": "Help and support",
    "Geral": "General", "Sistema e aparência": "System and appearance", "Acesso": "Access", "Segurança e permissões": "Security and permissions",
    "Qualidade e desempenho": "Quality and performance", "Aparência": "Appearance", "Tema e idioma": "Theme and language",
    "Alterações não salvas": "Unsaved changes", "Tudo salvo": "All changes saved", "Inicialização e Sistema": "Startup and System",
    "Defina como o Nodus deve se comportar com o seu sistema.": "Choose how Nodus behaves with your system.",
    "Iniciar Nodus com o Windows": "Start Nodus with Windows", "O aplicativo será iniciado automaticamente.": "The app will start automatically.",
    "Iniciar minimizado": "Start minimized", "Abrir o Nodus na bandeja do sistema.": "Open Nodus in the system tray.",
    "Minimizar para bandeja": "Minimize to tray", "Ao fechar a janela, manter o Nodus em execução.": "Keep Nodus running when the window is closed.",
    "Modo leve": "Lightweight mode", "Reduz o uso de memória e efeitos gráficos.": "Reduces memory use and visual effects.",
    "Notificar pedidos recebidos": "Notify incoming requests", "Exibe notificações de novas conexões.": "Shows notifications for new connections.",
    "Som ao receber pedido": "Sound for incoming requests", "Reproduz um som quando alguém solicitar acesso.": "Plays a sound when someone requests access.",
    "Privacidade": "Privacy", "Controle sua privacidade no aplicativo.": "Control your privacy in the application.",
    "Mostrar meu Nodus ID": "Show my Nodus ID", "Oculta o ID na tela inicial, sem encerrar o serviço.": "Hides the ID on the home screen without stopping the service.",
    "Confirmar antes de encerrar": "Confirm before ending", "Evita o encerramento acidental de uma sessão.": "Prevents accidentally ending a session.",
    "Atualizações": "Updates", "Mantenha o Nodus sempre atualizado.": "Keep Nodus up to date.", "Versão atual:": "Current version:",
    "Notas das versões": "Release notes", "Últimas atualizações": "Latest updates", "Painel de atualizações exibido acima da interface.": "Updates panel displayed above the interface.", "Área superior da home mais compacta.": "More compact home top area.", "Busca de dispositivos por nome ou Nodus ID.": "Search devices by name or Nodus ID.", "Sugestões para computadores conectados anteriormente.": "Suggestions for previously connected computers.", "Ajustes de responsividade na tela inicial.": "Home screen responsiveness improvements.", "Menus de dispositivos permanecem visíveis em telas menores.": "Device menus remain visible on smaller screens.", "Idiomas em inglês, russo e japonês.": "English, Russian, and Japanese languages.", "Senha de acesso pode ser salva neste dispositivo.": "The access password can be saved on this device.", "Melhorias nas configurações de acesso.": "Access settings improvements.", "Correções no fluxo de conexão por senha.": "Password connection flow fixes.",
    "Permitir mouse e teclado": "Allow mouse and keyboard", "Permitir envio de arquivos": "Allow file transfer", "Permitir texto copiado": "Allow clipboard text",
    "Compartilhar som do computador": "Share computer audio", "Aceitar automaticamente computadores confiaveis": "Automatically accept trusted computers",
    "Servico do Windows": "Windows Service", "Instalar servico": "Install service", "Iniciar servico": "Start service", "Parar servico": "Stop service", "Remover servico": "Remove service",
    "Senha deste Nodus": "This Nodus password", "Defina uma senha para este computador": "Set a password for this computer", "Senha configurada": "Password set",
    "Definir senha": "Set password", "Remover": "Remove", "Computadores confiaveis": "Trusted computers", "Nenhum computador autorizado.": "No authorized computers.",
    "Resolução preferida": "Preferred resolution", "Qualidade da tela": "Screen quality", "Automatica": "Automatic", "Alta": "High", "Equilibrada": "Balanced",
    "Economia de internet": "Save bandwidth", "Movimento da imagem": "Frame rate", "Tela compartilhada": "Shared display", "Tela principal": "Primary display",
    "Idioma": "Language", "Salvar": "Save", "Descartar": "Discard", "Meus dispositivos": "My devices", "Adicionar dispositivo": "Add device",
    "Acessar": "Access", "Este computador": "This computer", "Último acesso:": "Last access:", "agora": "now", "Renomear": "Rename", "Excluir dispositivo": "Delete device",
    "Dispositivos recentes": "Recent devices", "Nenhum dispositivo favorito": "No favorite devices", "Ver dispositivos": "View devices",
    "Controle": "Control", "Transferência": "Transfer", "Monitor": "Monitor", "Qualidade": "Quality", "Ações": "Actions", "Mais": "More", "Encerrar sessão": "End session",
    "Mouse ativo": "Mouse enabled", "Mouse bloqueado": "Mouse blocked", "Teclado ativo": "Keyboard enabled", "Teclado bloqueado": "Keyboard blocked",
    "Silenciar áudio": "Mute audio", "Ativar áudio": "Enable audio", "Enviar texto copiado": "Send clipboard text", "Solicitar administrador": "Request administrator",
    "Somente visualizar": "View only", "Canal de controle conectado": "Control channel connected", "Preparando controles": "Preparing controls",
    "Enviar arquivo": "Send file", "Nenhuma transferência nesta sessão.": "No transfers in this session.", "Destino": "Destination", "Documentos no computador remoto": "Documents on the remote computer",
    "Tela cheia": "Full screen", "Gravar sessão": "Record session", "Parar gravação": "Stop recording", "Sincronizar texto": "Sync text",
  },
  "ru-RU": {
    "Conexão": "Подключение", "Dispositivos": "Устройства", "Favoritos": "Избранное", "Configurações": "Настройки",
    "Bem-vindo de volta": "С возвращением", "Acesso remoto simples, rápido e seguro.": "Простой, быстрый и безопасный удаленный доступ.",
    "Seu Nodus ID": "Ваш Nodus ID", "Disponível para conexões": "Доступен для подключений", "Copiar Nodus ID": "Копировать Nodus ID",
    "Conectar a outro dispositivo": "Подключиться к другому устройству", "Digite o Nodus ID": "Введите Nodus ID", "Conectar": "Подключиться",
    "Usar senha de acesso": "Использовать пароль доступа", "Senha definida no outro Nodus": "Пароль задан на другом Nodus",
    "Salvar senha neste dispositivo": "Сохранить пароль на этом устройстве", "Recentes:": "Недавние:", "Status do Sistema": "Состояние системы",
    "Serviço Nodus": "Служба Nodus", "Conexão protegida": "Защищенное подключение", "Estável": "Стабильно", "Online": "В сети", "Offline": "Не в сети",
    "Acesso rápido": "Быстрый доступ", "Configurar senha": "Настроить пароль", "Ajuda e suporte": "Помощь и поддержка",
    "Geral": "Общие", "Sistema e aparência": "Система и внешний вид", "Acesso": "Доступ", "Segurança e permissões": "Безопасность и разрешения",
    "Qualidade e desempenho": "Качество и производительность", "Aparência": "Внешний вид", "Tema e idioma": "Тема и язык",
    "Alterações não salvas": "Изменения не сохранены", "Tudo salvo": "Все сохранено", "Inicialização e Sistema": "Запуск и система",
    "Defina como o Nodus deve se comportar com o seu sistema.": "Настройте работу Nodus в вашей системе.",
    "Iniciar Nodus com o Windows": "Запускать Nodus с Windows", "O aplicativo será iniciado automaticamente.": "Приложение будет запускаться автоматически.",
    "Iniciar minimizado": "Запускать свернутым", "Abrir o Nodus na bandeja do sistema.": "Открывать Nodus в системном трее.",
    "Minimizar para bandeja": "Сворачивать в трей", "Ao fechar a janela, manter o Nodus em execução.": "Оставлять Nodus работающим при закрытии окна.",
    "Modo leve": "Облегченный режим", "Reduz o uso de memória e efeitos gráficos.": "Снижает использование памяти и графических эффектов.",
    "Notificar pedidos recebidos": "Уведомлять о запросах", "Exibe notificações de novas conexões.": "Показывает уведомления о новых подключениях.",
    "Som ao receber pedido": "Звук при запросе", "Reproduz um som quando alguém solicitar acesso.": "Воспроизводит звук при запросе доступа.",
    "Privacidade": "Конфиденциальность", "Controle sua privacidade no aplicativo.": "Управляйте конфиденциальностью в приложении.",
    "Mostrar meu Nodus ID": "Показывать мой Nodus ID", "Oculta o ID na tela inicial, sem encerrar o serviço.": "Скрывает ID на главном экране без остановки службы.",
    "Confirmar antes de encerrar": "Подтверждать завершение", "Evita o encerramento acidental de uma sessão.": "Предотвращает случайное завершение сеанса.",
    "Atualizações": "Обновления", "Mantenha o Nodus sempre atualizado.": "Поддерживайте Nodus в актуальном состоянии.", "Versão atual:": "Текущая версия:",
    "Notas das versões": "Примечания к версиям", "Últimas atualizações": "Последние обновления", "Painel de atualizações exibido acima da interface.": "Панель обновлений отображается поверх интерфейса.", "Área superior da home mais compacta.": "Верхняя часть главного экрана стала компактнее.", "Busca de dispositivos por nome ou Nodus ID.": "Поиск устройств по имени или Nodus ID.", "Sugestões para computadores conectados anteriormente.": "Подсказки для ранее подключенных компьютеров.", "Ajustes de responsividade na tela inicial.": "Улучшена адаптивность главного экрана.", "Menus de dispositivos permanecem visíveis em telas menores.": "Меню устройств остаются видимыми на небольших экранах.", "Idiomas em inglês, russo e japonês.": "Добавлены английский, русский и японский языки.", "Senha de acesso pode ser salva neste dispositivo.": "Пароль доступа можно сохранить на этом устройстве.", "Melhorias nas configurações de acesso.": "Улучшены настройки доступа.", "Correções no fluxo de conexão por senha.": "Исправлен процесс подключения по паролю.",
    "Permitir mouse e teclado": "Разрешить мышь и клавиатуру", "Permitir envio de arquivos": "Разрешить передачу файлов", "Permitir texto copiado": "Разрешить буфер обмена",
    "Compartilhar som do computador": "Передавать звук компьютера", "Aceitar automaticamente computadores confiaveis": "Автоматически принимать доверенные компьютеры",
    "Servico do Windows": "Служба Windows", "Instalar servico": "Установить службу", "Iniciar servico": "Запустить службу", "Parar servico": "Остановить службу", "Remover servico": "Удалить службу",
    "Senha deste Nodus": "Пароль этого Nodus", "Defina uma senha para este computador": "Задайте пароль для этого компьютера", "Senha configurada": "Пароль задан",
    "Definir senha": "Задать пароль", "Remover": "Удалить", "Computadores confiaveis": "Доверенные компьютеры", "Nenhum computador autorizado.": "Нет авторизованных компьютеров.",
    "Resolução preferida": "Предпочтительное разрешение", "Qualidade da tela": "Качество экрана", "Automatica": "Автоматически", "Alta": "Высокое", "Equilibrada": "Сбалансированное",
    "Economia de internet": "Экономия трафика", "Movimento da imagem": "Частота кадров", "Tela compartilhada": "Общий экран", "Tela principal": "Основной экран",
    "Idioma": "Язык", "Salvar": "Сохранить", "Descartar": "Отменить", "Meus dispositivos": "Мои устройства", "Adicionar dispositivo": "Добавить устройство",
    "Acessar": "Открыть", "Este computador": "Этот компьютер", "Último acesso:": "Последний доступ:", "agora": "сейчас", "Renomear": "Переименовать", "Excluir dispositivo": "Удалить устройство",
    "Dispositivos recentes": "Недавние устройства", "Nenhum dispositivo favorito": "Нет избранных устройств", "Ver dispositivos": "Просмотреть устройства",
    "Controle": "Управление", "Transferência": "Передача", "Monitor": "Монитор", "Qualidade": "Качество", "Ações": "Действия", "Mais": "Еще", "Encerrar sessão": "Завершить сеанс",
    "Mouse ativo": "Мышь включена", "Mouse bloqueado": "Мышь заблокирована", "Teclado ativo": "Клавиатура включена", "Teclado bloqueado": "Клавиатура заблокирована",
    "Silenciar áudio": "Отключить звук", "Ativar áudio": "Включить звук", "Enviar texto copiado": "Отправить текст из буфера", "Solicitar administrador": "Запросить администратора",
    "Somente visualizar": "Только просмотр", "Canal de controle conectado": "Канал управления подключен", "Preparando controles": "Подготовка управления",
    "Enviar arquivo": "Отправить файл", "Nenhuma transferência nesta sessão.": "Нет передач в этом сеансе.", "Destino": "Назначение", "Documentos no computador remoto": "Документы на удаленном компьютере",
    "Tela cheia": "Полный экран", "Gravar sessão": "Записать сеанс", "Parar gravação": "Остановить запись", "Sincronizar texto": "Синхронизировать текст",
  },
  "ja-JP": {
    "Conexão": "接続", "Dispositivos": "デバイス", "Favoritos": "お気に入り", "Configurações": "設定",
    "Bem-vindo de volta": "おかえりなさい", "Acesso remoto simples, rápido e seguro.": "シンプルで高速、安全なリモートアクセス。",
    "Seu Nodus ID": "あなたの Nodus ID", "Disponível para conexões": "接続可能", "Copiar Nodus ID": "Nodus ID をコピー",
    "Conectar a outro dispositivo": "別のデバイスに接続", "Digite o Nodus ID": "Nodus ID を入力", "Conectar": "接続",
    "Usar senha de acesso": "アクセスパスワードを使用", "Senha definida no outro Nodus": "接続先 Nodus に設定されたパスワード",
    "Salvar senha neste dispositivo": "このデバイスにパスワードを保存", "Recentes:": "最近:", "Status do Sistema": "システム状態",
    "Serviço Nodus": "Nodus サービス", "Conexão protegida": "保護された接続", "Estável": "安定", "Online": "オンライン", "Offline": "オフライン",
    "Acesso rápido": "クイックアクセス", "Configurar senha": "パスワードを設定", "Ajuda e suporte": "ヘルプとサポート",
    "Geral": "一般", "Sistema e aparência": "システムと外観", "Acesso": "アクセス", "Segurança e permissões": "セキュリティと権限",
    "Qualidade e desempenho": "品質とパフォーマンス", "Aparência": "外観", "Tema e idioma": "テーマと言語",
    "Alterações não salvas": "未保存の変更", "Tudo salvo": "すべて保存済み", "Inicialização e Sistema": "起動とシステム",
    "Defina como o Nodus deve se comportar com o seu sistema.": "システム上での Nodus の動作を設定します。",
    "Iniciar Nodus com o Windows": "Windows と一緒に Nodus を起動", "O aplicativo será iniciado automaticamente.": "アプリは自動的に起動します。",
    "Iniciar minimizado": "最小化して起動", "Abrir o Nodus na bandeja do sistema.": "システムトレイで Nodus を開きます。",
    "Minimizar para bandeja": "トレイに最小化", "Ao fechar a janela, manter o Nodus em execução.": "ウィンドウを閉じても Nodus を実行し続けます。",
    "Modo leve": "軽量モード", "Reduz o uso de memória e efeitos gráficos.": "メモリ使用量と視覚効果を減らします。",
    "Notificar pedidos recebidos": "受信リクエストを通知", "Exibe notificações de novas conexões.": "新しい接続の通知を表示します。",
    "Som ao receber pedido": "リクエスト受信時に音を鳴らす", "Reproduz um som quando alguém solicitar acesso.": "アクセスが要求されると音を再生します。",
    "Privacidade": "プライバシー", "Controle sua privacidade no aplicativo.": "アプリのプライバシーを管理します。",
    "Mostrar meu Nodus ID": "Nodus ID を表示", "Oculta o ID na tela inicial, sem encerrar o serviço.": "サービスを停止せずにホーム画面の ID を隠します。",
    "Confirmar antes de encerrar": "終了前に確認", "Evita o encerramento acidental de uma sessão.": "セッションの誤終了を防ぎます。",
    "Atualizações": "アップデート", "Mantenha o Nodus sempre atualizado.": "Nodus を常に最新の状態に保ちます。", "Versão atual:": "現在のバージョン:",
    "Notas das versões": "リリースノート", "Últimas atualizações": "最新の更新", "Painel de atualizações exibido acima da interface.": "更新パネルを画面前面に表示。", "Área superior da home mais compacta.": "ホーム上部をよりコンパクトに調整。", "Busca de dispositivos por nome ou Nodus ID.": "名前または Nodus ID でデバイスを検索。", "Sugestões para computadores conectados anteriormente.": "以前接続したコンピューターを候補表示。", "Ajustes de responsividade na tela inicial.": "ホーム画面のレスポンシブ表示を改善。", "Menus de dispositivos permanecem visíveis em telas menores.": "小さな画面でもデバイスメニューを表示。", "Idiomas em inglês, russo e japonês.": "英語、ロシア語、日本語を追加。", "Senha de acesso pode ser salva neste dispositivo.": "アクセスパスワードをこのデバイスに保存可能。", "Melhorias nas configurações de acesso.": "アクセス設定を改善。", "Correções no fluxo de conexão por senha.": "パスワード接続の処理を修正。",
    "Permitir mouse e teclado": "マウスとキーボードを許可", "Permitir envio de arquivos": "ファイル送信を許可", "Permitir texto copiado": "クリップボードのテキストを許可",
    "Compartilhar som do computador": "コンピューターの音声を共有", "Aceitar automaticamente computadores confiaveis": "信頼済みコンピューターを自動的に許可",
    "Servico do Windows": "Windows サービス", "Instalar servico": "サービスをインストール", "Iniciar servico": "サービスを開始", "Parar servico": "サービスを停止", "Remover servico": "サービスを削除",
    "Senha deste Nodus": "この Nodus のパスワード", "Defina uma senha para este computador": "このコンピューターのパスワードを設定", "Senha configurada": "パスワード設定済み",
    "Definir senha": "パスワードを設定", "Remover": "削除", "Computadores confiaveis": "信頼済みコンピューター", "Nenhum computador autorizado.": "許可されたコンピューターはありません。",
    "Resolução preferida": "優先解像度", "Qualidade da tela": "画面品質", "Automatica": "自動", "Alta": "高", "Equilibrada": "バランス", "Economia de internet": "通信量を節約",
    "Movimento da imagem": "フレームレート", "Tela compartilhada": "共有画面", "Tela principal": "メイン画面", "Idioma": "言語", "Salvar": "保存", "Descartar": "破棄",
    "Meus dispositivos": "マイデバイス", "Adicionar dispositivo": "デバイスを追加", "Acessar": "アクセス", "Este computador": "このコンピューター", "Último acesso:": "最終アクセス:", "agora": "今", "Renomear": "名前を変更", "Excluir dispositivo": "デバイスを削除",
    "Dispositivos recentes": "最近のデバイス", "Nenhum dispositivo favorito": "お気に入りのデバイスはありません", "Ver dispositivos": "デバイスを表示",
    "Controle": "操作", "Transferência": "転送", "Monitor": "モニター", "Qualidade": "品質", "Ações": "操作", "Mais": "その他", "Encerrar sessão": "セッションを終了",
    "Mouse ativo": "マウス有効", "Mouse bloqueado": "マウス無効", "Teclado ativo": "キーボード有効", "Teclado bloqueado": "キーボード無効",
    "Silenciar áudio": "音声をミュート", "Ativar áudio": "音声を有効化", "Enviar texto copiado": "コピーしたテキストを送信", "Solicitar administrador": "管理者を要求",
    "Somente visualizar": "表示のみ", "Canal de controle conectado": "操作チャネル接続済み", "Preparando controles": "操作を準備中",
    "Enviar arquivo": "ファイルを送信", "Nenhuma transferência nesta sessão.": "このセッションには転送がありません。", "Destino": "保存先", "Documentos no computador remoto": "リモートコンピューターのドキュメント",
    "Tela cheia": "全画面", "Gravar sessão": "セッションを録画", "Parar gravação": "録画を停止", "Sincronizar texto": "テキストを同期",
  },
};

let observer: MutationObserver | undefined;

function baseText(value: string): string {
  for (const dictionary of Object.values(dictionaries)) {
    const source = Object.entries(dictionary).find(([, translated]) => translated === value)?.[0];
    if (source) return source;
  }
  return value;
}

function translate(value: string, language: UiLanguage): string {
  const lead = value.match(/^\s*/)?.[0] ?? "";
  const tail = value.match(/\s*$/)?.[0] ?? "";
  const base = baseText(value.trim());
  const translated = language === "pt-BR" ? base : dictionaries[language][base] ?? base;
  return `${lead}${translated}${tail}`;
}

function translateTree(root: Node, language: UiLanguage): void {
  const applyText = (node: Text) => {
    if (["SCRIPT", "STYLE"].includes(node.parentElement?.tagName ?? "")) return;
    const translated = translate(node.data, language);
    if (translated !== node.data) node.data = translated;
  };
  const applyAttributes = (element: Element) => {
    ["placeholder", "title", "aria-label", "data-tooltip"].forEach((attribute) => {
      const value = element.getAttribute(attribute);
      if (!value) return;
      const translated = translate(value, language);
      if (translated !== value) element.setAttribute(attribute, translated);
    });
  };
  if (root.nodeType === Node.TEXT_NODE) applyText(root as Text);
  if (root.nodeType === Node.ELEMENT_NODE) applyAttributes(root as Element);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) applyText(node as Text);
    else applyAttributes(node as Element);
    node = walker.nextNode();
  }
}

export function applyLanguage(language: UiLanguage): void {
  document.documentElement.lang = language;
  observer?.disconnect();
  if (!document.body) return;
  translateTree(document.body, language);
  observer = new MutationObserver((records) => records.forEach((record) => {
    if (record.type === "attributes") translateTree(record.target, language);
    else record.addedNodes.forEach((node) => translateTree(node, language));
  }));
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["placeholder", "title", "aria-label", "data-tooltip"] });
}

export function currentLocale(): UiLanguage {
  const language = document.documentElement.lang as UiLanguage;
  return ["pt-BR", "en-US", "ru-RU", "ja-JP"].includes(language) ? language : "pt-BR";
}
