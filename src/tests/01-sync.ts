import { startBridge, test, main } from './utils/Bridge';
import {
    getMattermostClient,
    getMatrixClient,
    getMattermostMembers,
    getMattermostTeamMembers,
} from './utils/Client';

import { waitEvent } from '../utils/Functions';
import {
    MATTERMOST_CHANNEL_IDS,
    MATRIX_ROOM_IDS,
    CHANNELS,
} from './utils/Data';

test('Start bridge', async t => {
    await startBridge(t);
    t.end();
});

test('initial sync', async t => {
    await Promise.all(
        CHANNELS.map(async channel => {
            t.deepEqual(
                await getMattermostMembers(channel),
                new Set([
                    'admin',
                    'mattermost_a',
                    'mattermost_b',
                    'ignored_user',
                    'matrix_matrix_a',
                    'matrix_matrix_b',
                ]),
            );
        }),
    );

    const matrixClient = getMatrixClient('admin');
    await Promise.all(
        Object.values(MATRIX_ROOM_IDS).map(async room => {
            const members = await matrixClient.getJoinedRoomMembers(room);
            t.deepEqual(
                new Set(Object.keys(members.joined)),
                new Set([
                    '@admin:localhost',
                    '@ignored_user:localhost',
                    '@matrix_a:localhost',
                    '@matrix_b:localhost',
                    '@mm_mattermost_a:localhost',
                    '@mm_mattermost_b:localhost',
                    '@matterbot:localhost',
                ]),
            );
        }),
    );

    t.end();
});

test('mattermost display names', async t => {
    const client = getMattermostClient('admin');
    const users = await client.post('/users/usernames', [
        'matrix_matrix_a',
        'matrix_matrix_b',
    ]);
    t.equal(users[0].first_name, 'Matrix UserA');
    t.equal(users[0].last_name, '');
    t.equal(users[1].first_name, 'matrix_b');
    t.equal(users[1].last_name, '');
    t.end();
});

test('matrix display names', t => {
    t.plan(2);
    const client = getMatrixClient('admin');
    for (const [user, display] of [
        ['mm_mattermost_a', 'MattermostUser A'],
        ['mm_mattermost_b', 'mattermost_b'],
    ]) {
        client
            .getProfileInfo(`@${user}:localhost`, 'displayname')
            .then(profile => {
                t.equal(profile.displayname, display + ' [mm]');
            });
    }
});

test('Sync mattermost leave', async t => {
    const matrixClient = getMatrixClient('admin');
    const mattermostClient = getMattermostClient('mattermost_a');

    const promise = waitEvent(main(), 'mattermost', 2);
    await mattermostClient.delete(
        `/channels/${MATTERMOST_CHANNEL_IDS['off-topic']}/members/${mattermostClient.userid}`,
    );
    await promise;

    const members = await matrixClient.getJoinedRoomMembers(
        MATRIX_ROOM_IDS['off-topic'],
    );
    t.deepEqual(
        new Set(Object.keys(members.joined)),
        new Set([
            '@admin:localhost',
            '@ignored_user:localhost',
            '@matrix_a:localhost',
            '@matrix_b:localhost',
            '@mm_mattermost_b:localhost',
            '@matterbot:localhost',
        ]),
    );

    t.end();
});

test('Sync mattermost join', async t => {
    const matrixClient = getMatrixClient('admin');
    const mattermostClient = getMattermostClient('mattermost_a');

    const promise = waitEvent(main(), 'mattermost', 2);
    await mattermostClient.post(
        `/channels/${MATTERMOST_CHANNEL_IDS['off-topic']}/members`,
        {
            user_id: mattermostClient.userid,
        },
    );
    await promise;

    const members = await matrixClient.getJoinedRoomMembers(
        MATRIX_ROOM_IDS['off-topic'],
    );
    t.deepEqual(
        new Set(Object.keys(members.joined)),
        new Set([
            '@admin:localhost',
            '@ignored_user:localhost',
            '@matrix_a:localhost',
            '@matrix_b:localhost',
            '@mm_mattermost_a:localhost',
            '@mm_mattermost_b:localhost',
            '@matterbot:localhost',
        ]),
    );
    t.end();
});

test('Sync matrix leave', async t => {
    const matrixClient = getMatrixClient('matrix_a');

    await Promise.all([
        waitEvent(main(), 'matrix'),
        waitEvent(main(), 'mattermost', 2),
        matrixClient.leave(MATRIX_ROOM_IDS['off-topic']),
    ]);

    t.deepEqual(
        await getMattermostMembers('off-topic'),
        new Set([
            'admin',
            'mattermost_a',
            'mattermost_b',
            'ignored_user',
            'matrix_matrix_b',
        ]),
    );

    t.end();
});

test('Sync matrix join', async t => {
    const matrixClient = getMatrixClient('matrix_a');

    await Promise.all([
        waitEvent(main(), 'matrix'),
        // 3 matterost event --- join, join post and user update
        waitEvent(main(), 'mattermost', 3),
        matrixClient.joinRoom(MATRIX_ROOM_IDS['off-topic']),
    ]);

    t.deepEqual(
        await getMattermostMembers('off-topic'),
        new Set([
            'admin',
            'mattermost_a',
            'mattermost_b',
            'ignored_user',
            'matrix_matrix_a',
            'matrix_matrix_b',
        ]),
    );

    t.end();
});

test('Leave mattermost team when all channels left', async t => {
    const matrixClient = getMatrixClient('matrix_a');

    // The number of mattermost messages depends on the order in which events
    // are processed. We don't check it because the bridge will be killed after
    // this.
    await Promise.all([
        waitEvent(main(), 'matrix', 2),
        matrixClient.leave(MATRIX_ROOM_IDS['off-topic']),
        matrixClient.leave(MATRIX_ROOM_IDS['town-square']),
    ]);

    t.deepEqual(
        await getMattermostTeamMembers(),
        new Set([
            'admin',
            'mattermost_a',
            'mattermost_b',
            'ignored_user',
            'matrix_matrix_b',
        ]),
    );

    await Promise.all([
        waitEvent(main(), 'matrix', 2),
        matrixClient.joinRoom(MATRIX_ROOM_IDS['off-topic']),
        matrixClient.joinRoom(MATRIX_ROOM_IDS['town-square']),
    ]);

    t.deepEqual(
        await getMattermostMembers('off-topic'),
        new Set([
            'admin',
            'mattermost_a',
            'mattermost_b',
            'ignored_user',
            'matrix_matrix_a',
            'matrix_matrix_b',
        ]),
    );

    t.end();
});

test('Kill bridge', async t => {
    await main().killBridge(0);
    t.end();
});
