Feature: Two players share one Earth
  Allegiance is online only: the Indie Machine API holds sessions, nations and the territory map,
  allegiance-realtime carries live play. Driven by tests/bdd/mmo.mjs against next dev (:3000),
  wrangler dev (:8787) and the game's Vite server (:5190).

  Scenario: The title says plainly when the server can't be reached
    Given the Allegiance API is unreachable from the browser
    When the game starts
    Then the title shows "THE ALLEGIANCE SERVER IS UNREACHABLE" with the reason
    And it offers RETRY instead of New Nation or Continue

  Scenario: An anonymous player founds a nation
    Given a fresh browser
    When the game starts
    Then the title offers "NEW NATION / NEW PARTY" and Continue is disabled
    When they found "Dawn Front", led by Ada, in London
    Then they are playing anonymously, online, in London's room

  Scenario: A second player arrives and they see each other
    Given a second fresh browser founds "Iron Choir", led by Mara, in London
    And Mara walks 14 m north
    Then Ada sees Mara in her room, with her name and nation over her
    And Mara sees Ada

  Scenario: A street fight is refereed by the room
    When Mara faces Ada and fires a rifle
    Then Ada is told Mara shot her, and her health drops

  Scenario: Territory taken from another player
    Given Ada's party takes her home town by war
    Then Mara's map shows the home town ruled by Dawn Front
    When Mara takes it by war with a far larger army
    Then Ada is told Iron Choir seized it, and her map shows it ruled by Iron Choir

  Scenario: An anonymous player keeps their nation with an account
    When Ada clicks CREATE ACCOUNT and submits an email and password
    Then she is signed in with that email, and still plays Dawn Front
