/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { Event, Emitter } from 'vs/base/common/event';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { ExtensionsRegistry, IExtensionPointUser } from 'vs/workbench/services/extensions/common/extensionsRegistry';
import { URI } from 'vs/base/common/uri';
import { ITunnelService } from 'vs/platform/remote/common/tunnel';
import { Disposable } from 'vs/base/common/lifecycle';
import { IEditableData } from 'vs/workbench/common/views';

export const IRemoteExplorerService = createDecorator<IRemoteExplorerService>('remoteExplorerService');
export const REMOTE_EXPLORER_TYPE_KEY: string = 'remote.explorerType';

export interface Tunnel {
	remote: number;
	localUri: URI;
	local?: number;
	name?: string;
	description?: string;
	closeable?: boolean;
}

export class TunnelModel extends Disposable {
	readonly forwarded: Map<number, Tunnel>;
	readonly published: Map<number, Tunnel>;
	readonly candidates: Map<number, Tunnel>;
	private _onForwardPort: Emitter<Tunnel> = new Emitter();
	public onForwardPort: Event<Tunnel> = this._onForwardPort.event;
	private _onClosePort: Emitter<number> = new Emitter();
	public onClosePort: Event<number> = this._onClosePort.event;
	private _onPortName: Emitter<number> = new Emitter();
	public onPortName: Event<number> = this._onPortName.event;
	constructor(
		@ITunnelService private readonly tunnelService: ITunnelService
	) {
		super();
		this.forwarded = new Map();
		this.tunnelService.tunnels.then(tunnels => {
			tunnels.forEach(tunnel => {
				if (tunnel.localAddress) {
					this.forwarded.set(tunnel.tunnelRemotePort, {
						remote: tunnel.tunnelRemotePort,
						localUri: tunnel.localAddress,
						local: tunnel.tunnelLocalPort
					});
				}
			});
		});

		this.published = new Map();
		this.candidates = new Map();
		this._register(this.tunnelService.onTunnelOpened(tunnel => {
			if (this.candidates.has(tunnel.tunnelRemotePort)) {
				this.candidates.delete(tunnel.tunnelRemotePort);
			}
			if (!this.forwarded.has(tunnel.tunnelRemotePort) && tunnel.localAddress) {
				this.forwarded.set(tunnel.tunnelRemotePort, {
					remote: tunnel.tunnelRemotePort,
					localUri: tunnel.localAddress,
					local: tunnel.tunnelLocalPort
				});
			}
			this._onForwardPort.fire(this.forwarded.get(tunnel.tunnelRemotePort)!);
		}));
		this._register(this.tunnelService.onTunnelClosed(remotePort => {
			if (this.forwarded.has(remotePort)) {
				this.forwarded.delete(remotePort);
				this._onClosePort.fire(remotePort);
			}
		}));
	}

	async forward(remote: number, local?: number, name?: string): Promise<void> {
		if (!this.forwarded.has(remote)) {
			const tunnel = await this.tunnelService.openTunnel(remote, local);
			if (tunnel && tunnel.localAddress) {
				const newForward: Tunnel = {
					remote: tunnel.tunnelRemotePort,
					local: tunnel.tunnelLocalPort,
					name: name,
					closeable: true,
					localUri: tunnel.localAddress
				};
				this.forwarded.set(remote, newForward);
				this._onForwardPort.fire(newForward);
			}
		}
	}

	name(remote: number, name: string) {
		if (this.forwarded.has(remote)) {
			this.forwarded.get(remote)!.name = name;
			this._onPortName.fire(remote);
		}
	}

	async close(remote: number): Promise<void> {
		return this.tunnelService.closeTunnel(remote);
	}

	address(remote: number): URI | undefined {
		return (this.forwarded.get(remote) || this.published.get(remote))?.localUri;
	}
}

export interface IRemoteExplorerService {
	_serviceBrand: undefined;
	onDidChangeTargetType: Event<string>;
	targetType: string;
	readonly helpInformation: HelpInformation[];
	readonly tunnelModel: TunnelModel;
	onDidChangeEditable: Event<number>;
	setEditable(remote: number, data: IEditableData | null): void;
	getEditableData(remote: number): IEditableData | undefined;
}

export interface HelpInformation {
	extensionDescription: IExtensionDescription;
	getStarted?: string;
	documentation?: string;
	feedback?: string;
	issues?: string;
	remoteName?: string[] | string;
}

const remoteHelpExtPoint = ExtensionsRegistry.registerExtensionPoint<HelpInformation>({
	extensionPoint: 'remoteHelp',
	jsonSchema: {
		description: nls.localize('RemoteHelpInformationExtPoint', 'Contributes help information for Remote'),
		type: 'object',
		properties: {
			'getStarted': {
				description: nls.localize('RemoteHelpInformationExtPoint.getStarted', "The url to your project's Getting Started page"),
				type: 'string'
			},
			'documentation': {
				description: nls.localize('RemoteHelpInformationExtPoint.documentation', "The url to your project's documentation page"),
				type: 'string'
			},
			'feedback': {
				description: nls.localize('RemoteHelpInformationExtPoint.feedback', "The url to your project's feedback reporter"),
				type: 'string'
			},
			'issues': {
				description: nls.localize('RemoteHelpInformationExtPoint.issues', "The url to your project's issues list"),
				type: 'string'
			}
		}
	}
});

class RemoteExplorerService implements IRemoteExplorerService {
	public _serviceBrand: undefined;
	private _targetType: string = '';
	private readonly _onDidChangeTargetType: Emitter<string> = new Emitter<string>();
	public readonly onDidChangeTargetType: Event<string> = this._onDidChangeTargetType.event;
	private _helpInformation: HelpInformation[] = [];
	private _tunnelModel: TunnelModel;
	private editable: { remote: number, data: IEditableData } | undefined;
	private readonly _onDidChangeEditable: Emitter<number> = new Emitter<number>();
	public readonly onDidChangeEditable: Event<number> = this._onDidChangeEditable.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ITunnelService tunnelService: ITunnelService) {
		this._tunnelModel = new TunnelModel(tunnelService);
		remoteHelpExtPoint.setHandler((extensions) => {
			let helpInformation: HelpInformation[] = [];
			for (let extension of extensions) {
				this._handleRemoteInfoExtensionPoint(extension, helpInformation);
			}

			this._helpInformation = helpInformation;
		});
	}

	set targetType(name: string) {
		if (this._targetType !== name) {
			this._targetType = name;
			this.storageService.store(REMOTE_EXPLORER_TYPE_KEY, this._targetType, StorageScope.WORKSPACE);
			this.storageService.store(REMOTE_EXPLORER_TYPE_KEY, this._targetType, StorageScope.GLOBAL);
			this._onDidChangeTargetType.fire(this._targetType);
		}
	}
	get targetType(): string {
		return this._targetType;
	}

	private _handleRemoteInfoExtensionPoint(extension: IExtensionPointUser<HelpInformation>, helpInformation: HelpInformation[]) {
		if (!extension.description.enableProposedApi) {
			return;
		}

		if (!extension.value.documentation && !extension.value.feedback && !extension.value.getStarted && !extension.value.issues) {
			return;
		}

		helpInformation.push({
			extensionDescription: extension.description,
			getStarted: extension.value.getStarted,
			documentation: extension.value.documentation,
			feedback: extension.value.feedback,
			issues: extension.value.issues,
			remoteName: extension.value.remoteName
		});
	}

	get helpInformation(): HelpInformation[] {
		return this._helpInformation;
	}

	get tunnelModel(): TunnelModel {
		return this._tunnelModel;
	}

	setEditable(remote: number, data: IEditableData | null): void {
		if (!data) {
			this.editable = undefined;
		} else {
			this.editable = { remote, data };
		}
		this._onDidChangeEditable.fire(remote);
	}

	getEditableData(remote: number): IEditableData | undefined {
		return this.editable && this.editable.remote === remote ? this.editable.data : undefined;
	}
}

registerSingleton(IRemoteExplorerService, RemoteExplorerService, true);
