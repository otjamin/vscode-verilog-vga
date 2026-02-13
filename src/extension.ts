import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { VGASimulatorPanel } from './VGASimulatorPanel';

export function activate(context: vscode.ExtensionContext) {
	const simulateCommand = vscode.commands.registerCommand('verilogvga.simulate', async () => {
		// Collect Verilog sources
		const sources = await collectVerilogSources();
		if (!sources) {
			return;
		}

		// Create or show the simulator panel
		const panel = VGASimulatorPanel.createOrShow(context.extensionUri);

		// Compile and run
		await panel.compileSources(sources);
	});

	context.subscriptions.push(simulateCommand);
}

async function collectVerilogSources(): Promise<Record<string, string> | undefined> {
	const editor = vscode.window.activeTextEditor;

	// If the active editor has a Verilog file, use the workspace folder's Verilog files
	if (editor) {
		const doc = editor.document;
		const ext = path.extname(doc.fileName).toLowerCase();

		if (ext === '.v' || ext === '.sv') {
			// Find all .v and .sv files in the same workspace folder
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
			if (workspaceFolder) {
				return await gatherVerilogFiles(workspaceFolder.uri);
			}
			// Single file fallback
			return { [path.basename(doc.fileName)]: doc.getText() };
		}
	}

	// No active Verilog file - ask user to pick one
	const files = await vscode.workspace.findFiles('**/*.{v,sv}', '**/node_modules/**');
	if (files.length === 0) {
		vscode.window.showErrorMessage('No Verilog (.v / .sv) files found in workspace.');
		return undefined;
	}

	const picked = await vscode.window.showQuickPick(
		files.map((f) => ({
			label: vscode.workspace.asRelativePath(f),
			uri: f,
		})),
		{ placeHolder: 'Select the main Verilog file to simulate' },
	);

	if (!picked) {
		return undefined;
	}

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(picked.uri);
	if (workspaceFolder) {
		return await gatherVerilogFiles(workspaceFolder.uri);
	}

	const content = (await vscode.workspace.fs.readFile(picked.uri)).toString();
	return { [path.basename(picked.uri.fsPath)]: content };
}

async function gatherVerilogFiles(folderUri: vscode.Uri): Promise<Record<string, string>> {
	const pattern = new vscode.RelativePattern(folderUri, '**/*.{v,sv}');
	const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
	const sources: Record<string, string> = {};

	for (const file of files) {
		const relativePath = path.relative(folderUri.fsPath, file.fsPath);
		const content = fs.readFileSync(file.fsPath, 'utf-8');
		sources[relativePath] = content;
	}

	return sources;
}

export function deactivate() {}
