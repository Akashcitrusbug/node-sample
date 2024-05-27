/*external modules*/
import _ from 'lodash';
/*DB*/
import { getClient, getClientTransaction, sql } from '../../../../../../db';
import { UserRole } from '../../../../../../db/types/role';
import { Chat, ChatType } from '../../../../../../db/types/chat';
import { Message as MessageDB } from '../../../../../../db/types/message';
import { ContractPermissionResult } from '../../../../../../db/types/contract';
import { InviteType } from '../../../../../../db/types/invite';
import { Collaborator, CollaboratorPermission } from '../../../../../../db/types/collaborator';
/*models*/
import { ChatModel } from '../../../../../../db/models/ChatModel';
import { CollaboratorModel } from '../../../../../../db/models/CollaboratorModel';
import { UserModel } from '../../../../../../db/models/UserModel';
/*GQL*/
import { execQuery } from '../../../..';
import { GraphQLError } from '../../../../../../gql';
import { Message } from '../../../../../../gql/resolvers/Types/Chat/Message';
/*other*/
import { Test } from '../../../../../helpers/Test';

type TQuery = { togglePinMessage: Message };

const enum Email {
  Pro = 'pro@test.com',
  Home = 'home@test.com',
  Collaborator = 'collaborator@test.com',
  Other = 'other@test.com'
}
const enum ChatTitle {
  Direct = 'direct',
  Group = 'group',
  General = 'general'
}
const enum ContractName {
  Chat = 'Chat'
}

interface OutputData {
  users: Test.TUser[];
  chats: Test.TChat[];
  messages: MessageDB[];
  project: Test.TProject;
  collaborator: Collaborator;
}

const requiredFieldSet: Test.TFieldSet<Message> = {
  scalar: ['id', 'chatId', 'fromId', 'text', 'pinned'],
  object: ['chat', 'from'],
  array: ['tags', 'files', 'replies']
};

const TOGGLE_PIN_MESSAGE_MUTATION = `mutation ($messageId: ID!) {
  togglePinMessage(messageId: $messageId) {
    id
    chatId
    fromId
    text
    editedAt
    tags
    pinned

    files {
      id
    }
    chat {
      id
    }
    from {
      id
    }
    replies {
      id
    }
  }
}`;

describe('gql/resolvers/Mutation/chats/messages/pin', () => {
  let outputData: OutputData;

  const inputData = {
    users: [
      {
        email: Email.Home,
        role: {
          name: UserRole.HomeOwner
        }
      },
      {
        email: Email.Pro,
        role: {
          name: UserRole.Pro
        }
      },
      {
        email: Email.Other,
        role: {
          name: UserRole.Pro
        }
      },
      {
        email: Email.Collaborator,
        role: {
          name: UserRole.Pro
        }
      }
    ],
    collaborator: {
      permissions: CollaboratorPermission.Read
    },
    invite: {
      firstName: 'test',
      inviteMessage: 'test message',
      type: InviteType.ContractCollaborator,
      userRole: UserRole.Pro
    },
    project: {
      matchData: {
        createdByOwner: true
      }
    },
    contract: {
      name: ContractName.Chat
    },
    chats: [
      {
        title: ChatTitle.Direct,
        type: ChatType.Direct
      },
      {
        title: ChatTitle.Group,
        type: ChatType.Group
      }
    ],
    message: {
      pinned: false,
      text: 'test'
    }
  };

  before(async () => {
    const ctx = { sql, events: [] };
    outputData = await getClientTransaction(async client => {
      const users = await Promise.all(
        _.map(inputData.users, async userData => {
          const userGenerate = new Test.UserGenerate(client, ctx);

          await userGenerate.create({ email: userData.email });
          await userGenerate.setRole({ name: userData.role.name });

          return userGenerate.user!;
        })
      );

      const homeUser = _.find(users, { email: Email.Home });
      if (!homeUser) throw GraphQLError.notFound('owner');

      const proUser = _.find(users, { email: Email.Pro });
      if (!proUser) throw GraphQLError.notFound('pro');

      const collaboratorUser = _.find(users, { email: Email.Collaborator });
      if (!collaboratorUser) throw GraphQLError.notFound('collaborator');

      const projectGenerate = new Test.ProjectGenerate(client, ctx);
      await projectGenerate.create({
        ownerId: homeUser.lastRoleId,
        matchData: inputData.project.matchData as any
      });
      await projectGenerate.addContract({
        name: inputData.contract.name,
        partnerId: proUser.lastRoleId
      });

      const project = projectGenerate.project!;

      const contract = _.find(project.contracts, { name: ContractName.Chat });
      if (!contract) throw GraphQLError.notFound('contract');

      const inviteGenerate = new Test.InviteGenerate(client, ctx);
      await inviteGenerate.create({
        ...inputData.invite,
        email: Email.Collaborator,
        invitedById: homeUser.lastRoleId
      });

      const invite = inviteGenerate.invite!;

      const collaboratorGenerate = new Test.CollaboratorGenerate(client, ctx);
      await collaboratorGenerate.create({
        roleId: collaboratorUser.lastRoleId,
        inviteId: invite.id,
        contractId: contract.id,
        invitedById: proUser.lastRoleId,
        approvedById: homeUser.lastRoleId,
        userRole: collaboratorUser.role!.name,
        email: Email.Collaborator,
        ...inputData.collaborator
      });

      const collaborator = collaboratorGenerate.collaborator!;

      const chats = await Promise.all(
        _.map(inputData.chats, async chatData => {
          const chatGenerate = new Test.ChatGenerate(client, ctx);

          await chatGenerate.create({
            contractId: contract.id,
            ownerId: homeUser.lastRoleId,
            ...chatData
          });
          await chatGenerate.inviteMember({ memberId: homeUser.lastRoleId });
          await chatGenerate.addMessage({
            fromId: homeUser.lastRoleId,
            ...inputData.message
          });

          return chatGenerate.chat!;
        })
      );

      const messages = _.map(chats, chat => chat.messages!).flat();

      return {
        users,
        project,
        collaborator,
        chats,
        messages
      };
    });
  });

  after(async () => {
    const ctx = { sql, events: [] };
    await getClientTransaction(async client => {
      await CollaboratorModel.remove.exec(
        client,
        {
          collaboratorId: outputData.collaborator.id
        },
        ctx
      );

      await Promise.all(
        _.map(outputData.users, user =>
          UserModel.remove.exec(
            client,
            {
              userId: user.id
            },
            ctx
          )
        )
      );
    });
  });

  // success
  it('should allow to toggle pin message', async () => {
    const homeUser = _.find(outputData.users, { email: Email.Home });
    const directChat = _.find(outputData.chats, { title: ChatTitle.Direct });

    if (!directChat) throw GraphQLError.notFound('chat');

    const messageInDirect = _.find(outputData.messages, {
      chatId: directChat.id
    });

    let { data, errors } = await execQuery<TQuery>(
      TOGGLE_PIN_MESSAGE_MUTATION,
      {
        messageId: _.get(messageInDirect, 'id')
      },
      homeUser
    );

    Test.Check.noErrors(errors, 'error');

    let result = data?.togglePinMessage;
    if (!result) throw GraphQLError.notFound('data');

    Test.Check.data(result, {
      pinned: true,
      text: _.get(messageInDirect, 'text')
    });

    ({ data, errors } = await execQuery<TQuery>(
      TOGGLE_PIN_MESSAGE_MUTATION,
      {
        messageId: _.get(messageInDirect, 'id')
      },
      homeUser
    ));

    Test.Check.noErrors(errors, 'error');

    result = data?.togglePinMessage;
    if (!result) throw GraphQLError.notFound('data');

    Test.Check.data(result, {
      pinned: false,
      text: _.get(messageInDirect, 'text')
    });

    Test.Check.requiredFields(requiredFieldSet, result);
  });

  describe('', () => {
    const ctx = { sql, events: [] };
    let collaboratorUser: Test.TUser | undefined;
    let directChat: Chat | undefined;
    let messageInDirect: MessageDB | undefined;

    before(async () => {
      collaboratorUser = _.find(outputData.users, {
        email: Email.Collaborator
      });
      directChat = _.find(outputData.chats, { title: ChatTitle.Direct });
      messageInDirect = _.find(outputData.messages, { chatId: directChat!.id });

      await getClient(async client => {
        await ChatModel.inviteMember.exec(
          client,
          {
            chatId: _.get(directChat!, 'id'),
            memberId: _.get(collaboratorUser!, 'lastRoleId')
          },
          ctx
        );
      });
    });

    after(async () => {
      const ctx = { sql, events: [] };
      await getClient(async client => {
        await ChatModel.removeMember.exec(
          client,
          {
            chatId: _.get(directChat!, 'id'),
            memberId: _.get(collaboratorUser!, 'lastRoleId')
          },
          ctx
        );
      });
    });

    it('should allow collaborator to toggle pin message in a direct chat', async () => {
      let { data, errors } = await execQuery<TQuery>(
        TOGGLE_PIN_MESSAGE_MUTATION,
        {
          messageId: _.get(messageInDirect, 'id')
        },
        collaboratorUser
      );

      Test.Check.noErrors(errors, 'error');

      let result = data?.togglePinMessage;
      if (!result) throw GraphQLError.notFound('data');

      Test.Check.data(result, {
        pinned: true,
        text: _.get(messageInDirect, 'text')
      });

      ({ data, errors } = await execQuery<TQuery>(
        TOGGLE_PIN_MESSAGE_MUTATION,
        {
          messageId: _.get(messageInDirect, 'id')
        },
        collaboratorUser
      ));

      Test.Check.noErrors(errors, 'error');

      result = data?.togglePinMessage;
      if (!result) throw GraphQLError.notFound('data');

      Test.Check.data(result, {
        pinned: false,
        text: _.get(messageInDirect, 'text')
      });

      Test.Check.requiredFields(requiredFieldSet, result);
    });
  });

  // error
  it('user is not a chat member', async () => {
    const proUser = _.find(outputData.users, { email: Email.Pro });
    const directChat = _.find(outputData.chats, { title: ChatTitle.Direct });

    if (!directChat) throw GraphQLError.notFound('chat');

    const messageInDirect = _.find(outputData.messages, {
      chatId: directChat.id
    });

    const { errors } = await execQuery<TQuery>(
      TOGGLE_PIN_MESSAGE_MUTATION,
      {
        messageId: _.get(messageInDirect, 'id')
      },
      proUser
    );

    Test.Check.error(errors, new GraphQLError('You are not a chat member.', 403));
  });

  it("other user have't access to contract", async () => {
    const otherUser = _.find(outputData.users, { email: Email.Other });
    const directChat = _.find(outputData.chats, { title: ChatTitle.Direct });

    if (!directChat) throw GraphQLError.notFound('chat');

    const messageInDirect = _.find(outputData.messages, {
      chatId: directChat.id
    });

    const { errors } = await execQuery<TQuery>(
      TOGGLE_PIN_MESSAGE_MUTATION,
      {
        messageId: _.get(messageInDirect, 'id')
      },
      otherUser
    );

    Test.Check.error(errors, new GraphQLError(ContractPermissionResult.NotContractUser, 403));
  });

  it(`collaborator hasn't write access in a group chat`, async () => {
    const collaboratorUser = _.find(outputData.users, {
      email: Email.Collaborator
    });
    const groupChat = _.find(outputData.chats, { title: ChatTitle.Group });

    if (!groupChat) throw GraphQLError.notFound('chat');

    const messageInGroup = _.find(outputData.messages, {
      chatId: groupChat.id
    });

    const { errors } = await execQuery<TQuery>(
      TOGGLE_PIN_MESSAGE_MUTATION,
      {
        messageId: _.get(messageInGroup, 'id')
      },
      collaboratorUser
    );

    Test.Check.error(errors, new GraphQLError(ContractPermissionResult.BadPermission, 403));
  });

  it('message not found', async () => {
    const homeUser = _.find(outputData.users, { email: Email.Home });
    const directChat = _.find(outputData.chats, { title: ChatTitle.Direct });

    if (!directChat) throw GraphQLError.notFound('chat');

    const messageInDirect = _.find(outputData.messages, {
      chatId: directChat.id
    });

    if (!messageInDirect) throw GraphQLError.notFound('message');

    const { errors } = await execQuery<TQuery>(
      TOGGLE_PIN_MESSAGE_MUTATION,
      {
        messageId: _.get(messageInDirect, 'id') + 1
      },
      homeUser
    );

    Test.Check.error(errors, GraphQLError.notFound('message'));
  });
});
