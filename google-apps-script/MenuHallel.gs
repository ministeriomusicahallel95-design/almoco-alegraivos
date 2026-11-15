/**
 * Adicione este arquivo ao Apps Script VINCULADO à planilha existente.
 * No onOpen existente, acrescente hallelAdicionarMenu();
 * Não substitua o onOpen ou qualquer integração já instalada.
 * Esta extensão só abre o painel: pagamentos e entregas são validados no servidor.
 */
function hallelAdicionarMenu() {
  SpreadsheetApp.getUi().createMenu('Almoço Alegrai-vos')
    .addItem('Abrir painel da equipe', 'hallelAbrirPainel')
    .addItem('Configurar endereço do painel', 'hallelConfigurarPainel')
    .addToUi();
}
function hallelConfigurarPainel() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt('Endereço do painel', 'Informe a URL HTTPS do painel publicado, terminando em /equipe.', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var url = response.getResponseText().trim();
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?\/equipe\/?$/i.test(url)) {
    ui.alert('Use um endereço HTTPS válido, sem parâmetros, terminando em /equipe.'); return;
  }
  PropertiesService.getDocumentProperties().setProperty('HALLEL_PANEL_URL', url);
  ui.alert('Endereço salvo. O painel continuará exigindo uma conta autorizada.');
}
function hallelAbrirPainel() {
  var url = PropertiesService.getDocumentProperties().getProperty('HALLEL_PANEL_URL');
  if (!url || !/^https:\/\/[a-z0-9.-]+(?::\d+)?\/equipe\/?$/i.test(url)) {
    SpreadsheetApp.getUi().alert('Configure primeiro o endereço do painel publicado.'); return;
  }
  var html = HtmlService.createHtmlOutput('<div style="font:14px Arial;padding:20px;line-height:1.7"><h2>Almoço Alegrai-vos</h2><p>Consulte pagamentos e registre as entregas por dia no painel da equipe.</p><p><a target="_blank" rel="noopener noreferrer" href="' + url + '">Abrir painel da equipe ↗</a></p><p>Use sua conta Google autorizada. Alterações manuais na planilha não confirmam pagamentos.</p></div>').setTitle('Almoço Alegrai-vos');
  SpreadsheetApp.getUi().showSidebar(html);
}
