import { Bridge, AppServiceRegistration } from 'matrix-appservice-bridge';
import { Client, Method, ClientWebsocket } from './mattermost/Client';
import { Config, config } from './Config';
import { User } from './entities/User';
import MatrixUserStore from './MatrixUserStore';
import MattermostUserStore from './MattermostUserStore';
import Channel from './Channel';
import Mutex from './utils/Mutex';
import * as Logger from './Logging';

export default class Main {
    readonly client: Client;
    readonly ws: ClientWebsocket;
    readonly mattermostUserStore: MattermostUserStore;
    readonly matrixUserStore: MatrixUserStore;
    readonly channelsByMattermost: Map<string, Channel>;
    readonly channelsByMatrix: Map<string, Channel>;
    readonly channelsByTeam: Map<string, Channel[]>;
    readonly bridge: Bridge;
    mattermostMutex: Mutex;
    matrixMutex: Mutex;

    constructor(registration: AppServiceRegistration) {
        this.bridge = new Bridge({
            homeserverUrl: config().homeserver.url,
            domain: config().homeserver.server_name,
            registration,
            controller: {
                onUserQuery: queriedUser => {
                    return {};
                },
                onEvent: request => {
                    this.onMatrixEvent(request);
                },
            },
            disableContext: true,
        });

        this.bridge.opts.userStore = undefined;
        this.bridge.opts.roomStore = undefined;
        this.bridge.opts.eventStore = undefined;

        this.bridge.run(
            config().appservice.port,
            config(),
            undefined,
            config().appservice.hostname,
        );

        this.client = new Client(
            config().mattermost_url,
            config().mattermost_bot_userid,
        );
        this.client.loginWithToken(config().mattermost_bot_access_token);
        this.ws = this.client.websocket();

        this.channelsByMatrix = new Map();
        this.channelsByMattermost = new Map();
        this.channelsByTeam = new Map();
        this.mattermostMutex = new Mutex();
        this.matrixMutex = new Mutex();
        this.mattermostUserStore = new MattermostUserStore(this);
        this.matrixUserStore = new MatrixUserStore(this);
        for (let map of config().mappings) {
            const channel = new Channel(this, map.matrix, map.mattermost);
            this.channelsByMattermost.set(map.mattermost, channel);
            this.channelsByMatrix.set(map.matrix, channel);
        }
        this.ws.on('message', m => this.onMattermostMessage(m));
    }

    async init() {
        const botProfile = this.updateBotProfile().catch(e =>
            Logger.error(`Error when updating bot profile: ${e}`),
        );

        await Promise.all([
            this.mattermostMutex.lock(),
            this.matrixMutex.lock(),
        ]);

        const promises: Promise<void>[] = [];
        for (let channel of this.channelsByMattermost.values()) {
            promises.push(
                channel
                    .syncChannel()
                    .then(() => channel.getTeam())
                    .then(team => {
                        const channels = this.channelsByTeam.get(team);
                        if (channels === undefined) {
                            this.channelsByTeam.set(team, [channel]);
                        } else {
                            channels.push(channel);
                        }
                    })
                    .catch(e => {
                        Logger.error(
                            `Error when syncing ${channel.matrixRoom} with ${channel.mattermostChannel}: ${e}`,
                        );
                        this.channelsByMattermost.delete(
                            channel.mattermostChannel,
                        );
                        this.channelsByMatrix.delete(channel.matrixRoom);
                    }),
            );
        }
        await Promise.all(promises);

        this.mattermostMutex.unlock();
        this.matrixMutex.unlock();

        await botProfile;
    }

    async updateBotProfile() {
        const intent = this.bridge.getIntent();
        // The bot believes itelf to always be registered, even when it isn't.
        // This part is copied from matrix-appservice-slack.
        intent.opts.registered = false;
        await intent._ensureRegistered();
        const targetProfile = config().matrix_bot;
        const profile = await intent.getProfileInfo(
            this.bridge.getBot().getUserId(),
        );
        if (
            targetProfile.display_name &&
            profile.displayname !== targetProfile.display_name
        ) {
            await intent.setDisplayName(targetProfile.display_name);
        }
    }

    async onMattermostMessage(m: any) {
        await this.mattermostMutex.lock();

        try {
            const userid = m.data.user_id ?? (m.data.user && m.data.user.id);

            if (userid) {
                if (
                    this.skipMattermostUser(userid) ||
                    !(await this.isMattermostUser(userid))
                ) {
                    this.mattermostMutex.unlock();
                    return;
                }
            }

            Logger.debug(`Mattermost message: ${JSON.stringify(m)}`);
            const handler = Main.mattermostMessageHandlers[m.event];
            if (handler !== undefined) {
                await handler.bind(this)(m);
            } else if (m.broadcast.channel_id !== '') {
                // We may have been invited to channels that are not bridged;
                const channel = this.channelsByMattermost.get(
                    m.broadcast.channel_id,
                );
                if (channel !== undefined) {
                    await channel.onMattermostMessage(m);
                } else {
                    Logger.debug(
                        `Message for unknown channel_id: ${m.broadcast.channel_id}`,
                    );
                }
            } else if (m.broadcast.team_id !== '') {
                const channels = await this.client.get(
                    `/teams/${m.broadcast.team_id}/channels`,
                );
                const promises: Promise<void>[] = [];
                for (const channel of channels) {
                    const c = this.channelsByMattermost.get(channel.id);
                    if (c !== undefined) {
                        promises.push(c.onMattermostMessage(m));
                    }
                }
                await Promise.all(promises);
            } else {
                Logger.debug(`Unkown event type: ${m.event}`);
            }
        } catch (e) {
            Logger.error(`Error when processing mattermost message: ${e}`);
        }

        this.mattermostMutex.unlock();
    }

    async onMatrixEvent(request) {
        await this.matrixMutex.lock();

        try {
            const event = request.getData();
            Logger.debug(`Matrix event: ${JSON.stringify(event)}`);

            const channel = this.channelsByMatrix.get(event.room_id);
            if (channel !== undefined) {
                await channel.onMatrixEvent(event);
            } else if (
                event.type === 'm.room.member' &&
                event.state_key &&
                this.bridge.getBot().isRemoteUser(event.state_key) &&
                event.content.is_direct
            ) {
                const intent = this.bridge.getIntent(event.state_key);
                await intent.sendEvent(event.room_id, 'm.room.message', {
                    body:
                        'Private messaging is not supported for this bridged user',
                    msgtype: 'm.notice',
                });
                await intent.leave();
            } else {
                Logger.debug(`Message for unknown room: ${event.room_id}`);
            }
        } catch (e) {
            Logger.error(`Error when processing matrix event: ${e}`);
        }

        this.matrixMutex.unlock();
    }

    async isMattermostUser(userid): Promise<boolean> {
        if (this.matrixUserStore.byMattermostUserId.get(userid) !== undefined) {
            return false;
        }
        const response = await User.findOne({
            mattermost_userid: userid,
        });
        return response === undefined || response.is_matrix_user === false;
    }

    skipMattermostUser(userid: string): boolean {
        const botMattermostUser = this.client.userid;
        const ignoredMattermostUsers = config().ignored_mattermost_users ?? [];
        return (
            userid === botMattermostUser ||
            ignoredMattermostUsers.includes(userid)
        );
    }

    skipMatrixUser(userid: string): boolean {
        const botMatrixUser = this.bridge.getBot().getUserId();
        const ignoredMatrixUsers = config().ignored_matrix_users ?? [];
        return userid === botMatrixUser || ignoredMatrixUsers.includes(userid);
    }

    static readonly mattermostMessageHandlers = {
        hello: () => {},
        added_to_team: () => {},
        new_user: () => {},
        status_change: () => {},
        channel_viewed: () => {},
        preferences_changed: () => {},
        sidebar_category_updated: () => {},
        direct_added: async function (this: Main, m: any) {
            await this.client.post('/posts', {
                channel_id: m.broadcast.channel_id,
                message: 'This is a bot. You will not get a reply',
            });
        },
        user_updated: async function (this: Main, m: any) {
            const user = this.mattermostUserStore.get(m.data.user.id);
            if (user !== undefined) {
                await this.mattermostUserStore.updateUser(m.data.user, user);
            }
        },
    };
}
