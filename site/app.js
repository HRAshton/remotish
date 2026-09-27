const container = document.querySelector('#examples');

function button(label, href, primary = false) {
  const link = document.createElement('a');
  link.className = primary ? 'button primary' : 'button';
  link.href = href;
  link.textContent = label;
  return link;
}

function renderExample(example) {
  const article = document.createElement('article');
  article.className = 'card';

  const kind = document.createElement('span');
  kind.className = 'card-kind';
  kind.textContent =
    example.kind === 'live' ? 'Live' : example.kind === 'setup' ? 'Setup required' : 'Source';

  const title = document.createElement('h3');
  title.textContent = example.name;

  const summary = document.createElement('p');
  summary.textContent = example.summary;

  article.append(kind, title, summary);

  if (example.command) {
    const command = document.createElement('p');
    command.className = 'card-command';
    command.append('After opening the workbench, run:');
    const code = document.createElement('code');
    code.textContent = example.command;
    command.append(code);
    article.append(command);
  } else {
    article.append(document.createElement('div'));
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  if (example.launch) {
    actions.append(button('Open workbench', new URL(example.launch, window.location.href), true));
  }
  actions.append(button('Documentation', example.docs));
  article.append(actions);

  return article;
}

try {
  const response = await fetch('./examples.json');
  if (!response.ok) {
    throw new Error(`examples.json returned ${response.status}`);
  }
  const registry = await response.json();
  container.replaceChildren(...registry.examples.map(renderExample));
} catch (error) {
  const message = document.createElement('p');
  message.textContent = `Unable to load examples: ${error instanceof Error ? error.message : String(error)}`;
  container.replaceChildren(message);
}
