import { ClientError } from './mattermost/Client';
import { MatrixEvent, MattermostMessage } from './Interfaces';
import log from './Logging';
import Main from './Main';
import MatrixHandlers from './MatrixHandler';
import MattermostHandlers from './MattermostHandler';

const MAX_MEMBERS: number = 10000;

export default class Channel {
    team?: string;

    constructor(
        readonly main: Main,
        readonly matrixRoom: string,
        readonly mattermostChannel: string,
    ) {}

    async getMatrixUsers(): Promise<{
        real: Set<string>;
        remote: Set<string>;
    }> {
        const bot = this.main.bridge.getBot();

        const realMatrixUsers: Set<string> = new Set();
        const remoteMatrixUsers: Set<string> = new Set();

        const allMatrixUsers = Object.keys(
            await bot.getJoinedMembers(this.matrixRoom),
        );
        for (const matrixUser of allMatrixUsers) {
            if (bot.isRemoteUser(matrixUser)) {
                remoteMatrixUsers.add(matrixUser);
            } else {
                realMatrixUsers.add(matrixUser);
            }
        }
        return {
            real: realMatrixUsers,
            remote: remoteMatrixUsers,
        };
    }

    async getMattermostUsers(): Promise<Set<string>> {
        const mattermostUsers: Set<string> = new Set();
        const query = await this.main.client.send(
            'GET',
            `/channels/${this.mattermostChannel}/members?page=0&per_page=${MAX_MEMBERS}`,
        );

        for (const member of query) {
            mattermostUsers.add(member.user_id);
        }
        return mattermostUsers;
    }

    async getTeam(): Promise<string> {
        if (this.team === undefined) {
            this.team = (
                await this.main.client.get(
                    `/channels/${this.mattermostChannel}`,
                )
            ).team_id as string;
        }
        return this.team;
    }

    async joinMattermost(userid: string): Promise<void> {
        const team = await this.getTeam();
        try {
            await this.main.client.post(`/teams/${team}/members`, {
                user_id: userid,
                team_id: team,
            });
        } catch (e) {}
        await this.main.client.post(
            `/channels/${this.mattermostChannel}/members`,
            {
                user_id: userid,
            },
        );
    }

    async leaveMattermost(userid: string): Promise<void> {
        try {
            await this.main.client.delete(
                `/channels/${this.mattermostChannel}/members/${userid}`,
            );
        } catch (e) {
            if (
                e instanceof ClientError &&
                e.m.id === 'api.channel.remove.default.app_error'
            ) {
                log.debug(
                    `Cannot remove user ${userid} from default town-square channel`,
                );
            } else if (
                e instanceof ClientError &&
                e.m.id === 'store.sql_channel.get_member.missing.app_error'
            ) {
                log.debug(
                    `User ${userid} already removed from channel ${this.mattermostChannel}`,
                );
            } else {
                throw e;
            }
        }
    }

    async syncChannel(): Promise<void> {
        const bridge = this.main.bridge;

        await Promise.all([
            bridge.getIntent().join(this.matrixRoom),
            this.joinMattermost(this.main.client.userid),
        ]);

        const [matrixUsers, mattermostUsers] = await Promise.all([
            this.getMatrixUsers(),
            this.getMattermostUsers(),
        ]);

        await Promise.all(
            Array.from(matrixUsers.real, async matrix_userid => {
                if (this.main.skipMatrixUser(matrix_userid)) {
                    return;
                }
                const user = await this.main.matrixUserStore.getOrCreate(
                    matrix_userid,
                    true,
                );
                mattermostUsers.delete(user.mattermost_userid);
                await this.joinMattermost(user.mattermost_userid);
            }),
        );

        await Promise.all(
            Array.from(mattermostUsers, async userid => {
                if (this.main.skipMattermostUser(userid)) {
                    return;
                }
                if (!(await this.main.isMattermostUser(userid))) {
                    this.leaveMattermost(userid);
                } else {
                    const user = await this.main.mattermostUserStore.getOrCreate(
                        userid,
                        true,
                    );
                    matrixUsers.remote.delete(user.matrix_userid);
                    const intent = bridge.getIntent(user.matrix_userid);
                    await intent.join(this.matrixRoom);
                }
            }),
        );

        await Promise.all(
            Array.from(matrixUsers.remote, async matrix_userid => {
                const intent = bridge.getIntent(matrix_userid);
                await intent.leave(this.matrixRoom);
            }),
        );
    }

    async onMattermostMessage(m: MattermostMessage): Promise<void> {
        const handler = MattermostHandlers[m.event];
        if (handler === undefined) {
            log.debug(`Unknown matermost message type: ${m.event}`);
        } else {
            await handler.bind(this)(m);
        }
    }

    async onMatrixEvent(event: MatrixEvent): Promise<void> {
        const handler = MatrixHandlers[event.type];
        if (handler === undefined) {
            log.debug(`Unknown matrix event type: ${event.type}`);
        } else {
            await handler.bind(this)(event);
        }
    }
}
